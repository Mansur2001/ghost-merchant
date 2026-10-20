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
import { normalizeReference, manualReceiptId } from '../domain/paymentRef.js';
import { EVENTS } from '../events/bus.js';
import { enqueue, wakeOutbox } from '../events/outbox.js';
import { config } from '../config.js';

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

// Operator: the money is on the merchant phone. `reference` is the transaction id from that
// receipt; it is optional, but without it the same payment could be confirmed twice.
export async function confirmPayment({ orderId, reference, actor }) {
  const ref = referenceOrThrow(reference);
  const receiptId = ref || manualReceiptId(orderId);

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
        sender_msisdn: order.user_phone,
        amount: order.total_amount,
        matched: true,
        provider: 'manual',
        sender_name: actor,
      },
    });
    const updated = await transitionOrder(
      orderId,
      STATUS.PAID_UNASSIGNED,
      actor,
      ref ? `payment confirmed (ref ${ref})` : 'payment confirmed (no reference)',
      { client: tx }
    );
    await enqueue(tx, EVENTS.PAYMENT_RECEIVED, {
      orderId,
      amount: order.total_amount,
      receiptId,
    });
    return updated;
  });

  wakeOutbox();
  return result;
}
