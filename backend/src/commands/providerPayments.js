// Taking a payment through WaafiPay (EVC Plus, Zaad, Sahal). domain/waafipay.js has the wire
// format; this is the lifecycle of one attempt:
//
//   start   order is PENDING_PAYMENT -> a `payment_attempts` row, status 'pending'.
//           Answered at once (202): the gateway call blocks until the customer types their PIN,
//           which can take a minute, and a phone on a Somali network won't hold a request open
//           that long. The result reaches the customer over the socket.
//   settle  the gateway answered:
//             approved -> confirmPayment (payment row + PAID + dispatch), attempt approved,
//                         all in ONE transaction
//             declined -> attempt declined; the customer can try again
//             unknown  -> attempt unknown; NO automatic retry for UNKNOWN_HOLD_MS, because the
//                         customer may have been charged. The operator checks the merchant
//                         account, exactly as for an "I've paid" claim.
//
// The money never passes through us (invariant 6); this only asks the gateway to collect it
// into the merchant account and records what it says happened.
import { prisma, withTransaction } from '../db/prisma.js';
import { config } from '../config.js';
import { newOrderId } from '../domain/ids.js';
import { STATUS } from '../domain/stateMachine.js';
import { buildPurchaseRequest, readPurchaseResponse, payerAccountNo } from '../domain/waafipay.js';
import { normalizeReference } from '../domain/paymentRef.js';
import { EVENTS } from '../events/bus.js';
import { enqueue, wakeOutbox } from '../events/outbox.js';
import { confirmPayment, PaymentError } from './payments.js';
import { postMessage } from './orders.js';
import { auditAfter } from './audit.js';

// The customer has this long to approve on their handset before we stop waiting.
export const GATEWAY_TIMEOUT_MS = 90_000;
// After an answer we couldn't read, no new prompt for this long: the first may have charged.
export const UNKNOWN_HOLD_MS = 10 * 60 * 1000;
// A 'pending' row older than this means the process died mid-call. It becomes 'unknown'.
export const STALE_PENDING_MS = GATEWAY_TIMEOUT_MS + 60_000;

const ACTOR = 'system:waafipay';

export const snapshot = (a) => ({
  orderId: a.order_id,
  attemptId: a.id,
  status: a.status,
  wallet: a.wallet,
  detail: a.status === 'declined' ? a.detail : null,
});

// Start a wallet prompt. Returns the attempt (an existing pending one if there is one, so a
// double tap is one prompt, not two). Authorization is the route's job.
export async function startWalletPayment({ orderId, wallet, phone, settings = config.waafipay, fetchImpl = fetch }) {
  if (!settings.enabled) throw new PaymentError('paying in the app is not available yet', 404);
  if (!settings.wallets.includes(wallet)) throw new PaymentError('choose EVC Plus, Zaad or Sahal');
  const accountNo = payerAccountNo(phone);
  if (!accountNo) throw new PaymentError('enter the Somali number of the wallet that pays');

  const result = await withTransaction(async (tx) => {
    // RAW: FOR UPDATE, so two taps can't both see "no pending attempt" and both prompt.
    const rows = await tx.$queryRaw`
      SELECT id, status, total_amount, kind FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
    `;
    const order = rows[0];
    if (!order) throw new PaymentError('order not found', 404);
    if (order.status !== STATUS.PENDING_PAYMENT) throw new PaymentError('this order is already paid', 409);

    const pending = await tx.paymentAttempt.findFirst({ where: { order_id: orderId, status: 'pending' } });
    if (pending) return { attempt: pending, created: false };

    const unclear = await tx.paymentAttempt.findFirst({
      where: { order_id: orderId, status: 'unknown', updated_at: { gt: new Date(Date.now() - UNKNOWN_HOLD_MS) } },
    });
    if (unclear) {
      throw new PaymentError(
        'we could not tell if your last payment went through. Check your payment messages; if money left, tap "I\'ve paid"',
        409
      );
    }

    const attempt = await tx.paymentAttempt.create({
      data: {
        id: newOrderId(),
        order_id: orderId,
        provider: 'waafipay',
        wallet,
        payer: `+${accountNo}`,
        amount: order.total_amount,
      },
    });
    await enqueue(tx, EVENTS.PAYMENT_ATTEMPT, snapshot(attempt));
    return { attempt, created: true, kind: order.kind };
  });

  if (result.created) {
    wakeOutbox();
    // Not awaited: the answer to the customer is "check your phone", not the gateway's result.
    settleWalletPayment({ attempt: result.attempt, accountNo, kind: result.kind, settings, fetchImpl })
      .catch((err) => console.error(`[waafipay] attempt ${result.attempt.id}: ${err.message}`));
  }
  return result.attempt;
}

async function callGateway({ attempt, accountNo, kind, settings, fetchImpl }) {
  const body = buildPurchaseRequest({
    settings,
    attemptId: attempt.id,
    orderId: attempt.order_id,
    accountNo,
    amount: Number(attempt.amount).toFixed(2),
    description: kind === 'RIDE' ? 'GuriKaabe ride' : 'GuriKaabe order',
  });
  try {
    const res = await fetchImpl(settings.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return readPurchaseResponse(res.status, json);
  } catch (err) {
    // A timeout is the dangerous case: the customer may approve a second after we gave up.
    return { status: 'unknown', detail: err.name === 'TimeoutError' ? 'no answer from the gateway' : 'network error' };
  }
}

// Exported for tests; production reaches it only through startWalletPayment.
export async function settleWalletPayment({ attempt, accountNo, kind, settings, fetchImpl }) {
  const outcome = await callGateway({ attempt, accountNo, kind, settings, fetchImpl });
  return applyOutcome(attempt, outcome);
}

export async function applyOutcome(attempt, outcome) {
  if (outcome.status === 'approved') {
    const reference = normalizeReference(outcome.reference);
    if (!reference) return markAttempt(attempt, { status: 'unknown', detail: `unreadable transactionId ${String(outcome.reference).slice(0, 40)}` });
    try {
      await confirmPayment({
        orderId: attempt.order_id,
        reference,
        amount: outcome.amount ?? attempt.amount,
        actor: ACTOR,
        provider: 'waafipay',
        payer: attempt.payer,
        // Same commit as the payment row: an approved attempt and a paid order, or neither.
        withinTx: async (tx) => {
          const updated = await tx.paymentAttempt.update({
            where: { id: attempt.id },
            data: { status: 'approved', reference, updated_at: new Date() },
          });
          await enqueue(tx, EVENTS.PAYMENT_ATTEMPT, snapshot(updated));
        },
      });
      wakeOutbox();
      return 'approved';
    } catch (err) {
      if (!(err instanceof PaymentError)) throw err;
      // Money was taken but can't be applied (order cancelled meanwhile, amount differs, the
      // reference was used). Never forced through: logged for the owner to refund.
      auditAfter({
        actor: ACTOR, action: 'payment.unmatched', subject: `order:${attempt.order_id}`,
        detail: { reference, amount: String(outcome.amount ?? attempt.amount), payer: attempt.payer, reason: err.message },
      });
      await markAttempt(attempt, { status: 'approved', reference, detail: `not applied: ${err.message}`.slice(0, 200) });
      return 'unmatched';
    }
  }
  await markAttempt(attempt, { status: outcome.status, detail: String(outcome.detail || '').slice(0, 200) });
  return outcome.status;
}

async function markAttempt(attempt, { status, reference = null, detail = null }) {
  await withTransaction(async (tx) => {
    // Only a pending attempt moves: a late duplicate answer must not overwrite a settled one.
    const changed = await tx.paymentAttempt.updateMany({
      where: { id: attempt.id, status: 'pending' },
      data: { status, reference, detail, updated_at: new Date() },
    });
    if (changed.count === 0) return;
    const updated = await tx.paymentAttempt.findUnique({ where: { id: attempt.id } });
    await enqueue(tx, EVENTS.PAYMENT_ATTEMPT, snapshot(updated));
    if (status === 'declined') {
      await postMessage({
        orderId: attempt.order_id, sender: 'system',
        body: 'The payment was not approved on your phone. You can try again.',
      }, { client: tx });
    } else if (status === 'unknown') {
      await postMessage({
        orderId: attempt.order_id, sender: 'system',
        body: 'We could not confirm the payment yet. If money left your wallet, tap "I\'ve paid" — an operator will check.',
      }, { client: tx });
    }
  });
  wakeOutbox();
  return status;
}

// Rows left 'pending' by a restart mid-call. Run on a timer.
export async function sweepStaleAttempts(now = Date.now()) {
  const stale = await prisma.paymentAttempt.findMany({
    where: { status: 'pending', created_at: { lt: new Date(now - STALE_PENDING_MS) } },
    take: 50,
  });
  for (const a of stale) {
    // eslint-disable-next-line no-await-in-loop
    await markAttempt(a, { status: 'unknown', detail: 'no answer recorded (server restarted?)' });
  }
  return stale.length;
}
