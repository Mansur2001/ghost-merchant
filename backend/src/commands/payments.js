// CQRS write side for payments.
//
// There is no device reading telecom receipts. The customer pays the merchant directly over
// EVC Plus / eDahab (invariant 6 — the platform never touches the money), and an OPERATOR
// confirms it by checking the merchant phone. Two steps, deliberately unequal:
//
//   claimPayment    — the customer says "I've paid", optionally with the reference. A hint for
//                     the operator: it changes NOTHING about the order's status, because a
//                     claim is not a payment and anyone can tap a button.
//   confirmPayment  — the operator saw the money arrive. Records the payment and moves the order
//                     to PAID_UNASSIGNED, in ONE transaction.
//
// Recording the payment is not bookkeeping for its own sake: the refund ledger sums an order's
// matched payments when it fails (commands/refunds.js). A paid order with no payment row would
// fail owing nothing, and the customer's money would be forgotten.
import { withTransaction, withCriticalTransaction } from '../db/prisma.js';
import { transitionOrder, postMessage } from './orders.js';
import { STATUS } from '../domain/stateMachine.js';
import { normalizeReference } from '../domain/paymentRef.js';

// Money compared in whole cents: 7.5 and "7.50" are the same price, 7.499 is not.
const toCents = (v) => Math.round(Number(v) * 100);
import { EVENTS } from '../events/bus.js';
import { enqueue, wakeOutbox } from '../events/outbox.js';
import { config } from '../config.js';
import { dispatchOrder } from './dispatch.js';
import { audit } from './audit.js';

export class PaymentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function referenceOrThrow(raw) {
  const ref = normalizeReference(raw);
  if (ref === null) throw new PaymentError('that does not look like a transaction reference');
  return ref;
}

// Which wallet the customer says they paid with, so the operator checks the right merchant
// phone. Only a wallet we actually offer is accepted; absent is fine (old app builds, or a
// manual-path order).
function walletOrThrow(raw, wallets) {
  if (raw === undefined || raw === null || raw === '') return null;
  const wallet = wallets.find((w) => w.id === raw);
  if (!wallet) throw new PaymentError('unknown wallet');
  return wallet;
}

// Customer: "I've paid". Re-claiming just updates the reference (a typo fix is not a second
// payment). Authorization — that this is THEIR order — is the route's job (requireOrderAccess).
export async function claimPayment({ orderId, reference, wallet: walletId, wallets = config.payment.wallets }) {
  const ref = referenceOrThrow(reference);
  const wallet = walletOrThrow(walletId, wallets);

  const order = await withTransaction(async (tx) => {
    // RAW: FOR UPDATE, so a claim can't race the operator's confirmation into a stale state.
    const rows = await tx.$queryRaw`
      SELECT id, status FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
    `;
    if (!rows[0]) throw new PaymentError('order not found', 404);
    if (rows[0].status !== STATUS.PENDING_PAYMENT) {
      throw new PaymentError('this order is already paid', 409);
    }

    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        payment_claimed_at: new Date(),
        payment_claim_ref: ref || null,
        payment_claim_wallet: wallet?.id ?? null,
      },
    });
    const via = wallet ? ` with ${wallet.name}` : '';
    await postMessage(
      {
        orderId,
        sender: 'system',
        body: `Customer says they have paid${via}.${ref ? ` Reference: ${ref}` : ''}`,
      },
      { client: tx }
    );
    // A snapshot, like every other event: safe to deliver twice.
    await enqueue(tx, EVENTS.PAYMENT_CLAIMED, {
      orderId,
      reference: ref || null,
      wallet: wallet?.id ?? null,
      walletName: wallet?.name ?? null,
      claimedAt: updated.payment_claimed_at,
    });
    return updated;
  });

  wakeOutbox();
  return order;
}

// The money is on the merchant phone. Called by an operator (PAYMENT_CONFIRMATION=operator)
// or by the provider's signed callback (=api). `reference` is the telecom's transaction id and
// is REQUIRED: it is the only thing that ties one real payment to one order, and the only thing
// anyone can check against the telecom's records later. `amount`, when the caller knows it
// (the API always does), must equal the order total to the cent.
//
// A paid order is dispatched in the same transaction — no human chooses the driver.
//
// `provider` names the rail on the payment row ('manual' = an operator; 'waafipay' = the
// gateway approved it). `withinTx(tx)` lets a caller record its own bookkeeping (the gateway
// attempt) in the same commit as the payment, so the two can never disagree after a crash.
export async function confirmPayment({ orderId, reference, amount, actor, provider = 'manual', payer = null, withinTx = null }) {
  const ref = referenceOrThrow(reference);
  if (!ref) throw new PaymentError('enter the transaction number from the payment');
  const receiptId = ref;

  // CP path: money. Linearizable and durable before we answer.
  const result = await withCriticalTransaction(async (tx) => {
    // RAW: FOR UPDATE. Two operators confirming at once must not both record a payment.
    const rows = await tx.$queryRaw`
      SELECT id, status, user_phone, total_amount FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
    `;
    const order = rows[0];
    if (!order) throw new PaymentError('order not found', 404);
    if (order.status !== STATUS.PENDING_PAYMENT) {
      throw new PaymentError('this order is not waiting for payment', 409);
    }
    if (amount !== undefined && amount !== null && toCents(amount) !== toCents(order.total_amount)) {
      throw new PaymentError(`amount ${amount} does not match the order total ${order.total_amount}`, 409);
    }

    // UNIQUE telecom_receipt_id is the real guarantee (invariant 2); this check only turns a
    // constraint error into a sentence the operator can act on.
    const used = await tx.transaction.findUnique({
      where: { telecom_receipt_id: receiptId },
      select: { order_id: true },
    });
    if (used) {
      throw new PaymentError(
        `reference ${ref} was already used to confirm order #${String(used.order_id).slice(0, 8)}`,
        409
      );
    }

    await tx.transaction.create({
      data: {
        order_id: orderId,
        telecom_receipt_id: receiptId,
        sender_msisdn: payer || order.user_phone,
        amount: order.total_amount,
        matched: true,
        provider,
        sender_name: actor,
      },
    });
    const updated = await transitionOrder(
      orderId,
      STATUS.PAID_UNASSIGNED,
      actor,
      `payment confirmed (ref ${ref})`,
      { client: tx }
    );
    await enqueue(tx, EVENTS.PAYMENT_RECEIVED, {
      orderId,
      amount: order.total_amount,
      receiptId,
    });
    await audit({
      actor, action: 'payment.confirmed', subject: `order:${orderId}`,
      detail: { reference: ref, amount: String(order.total_amount) },
    }, { client: tx });
    if (withinTx) await withinTx(tx);
    // A free driver gets it now; otherwise it waits for the next one to free up.
    const driver = await dispatchOrder(tx, orderId);
    return driver ? { ...updated, status: STATUS.DISPATCHED, driver_id: driver.id } : updated;
  });

  wakeOutbox();
  return result;
}
