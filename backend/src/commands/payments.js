// CQRS write side for payments. Called by the Oracle webhook. Records the receipt
// (idempotently, via UNIQUE telecom_receipt_id) and tries to match it to a pending order.
//
// Matching is deliberately conservative: exact amount + sender phone + PENDING_PAYMENT,
// most-recent first. Anything ambiguous or unmatched is left for the operator's manual
// "Mark as Paid" queue — automated systems WILL have edge cases and that override is a
// core feature, not a safety net.
//
// ONE TRANSACTION, on purpose. This used to insert the receipt, commit, and then transition
// the order in a second transaction. A crash in between left money received against an order
// still showing "awaiting payment" — the single worst state this system can be in, because
// the customer has paid and nothing in the app agrees. Receipt + transition + events now
// commit together or not at all.
import { withCriticalTransaction } from '../db/prisma.js';
import { transitionOrder } from './orders.js';
import { STATUS } from '../domain/stateMachine.js';
import { parsePhone } from '../domain/phone.js';
import { EVENTS } from '../events/bus.js';
import { enqueue, wakeOutbox } from '../events/outbox.js';

export async function recordAndMatchPayment({ receiptId, senderMsisdn, amount, rawSms }) {
  if (!receiptId) throw new Error('receiptId (telecom_receipt_id) required');
  // Normalize the sender to the same canonical E.164 identity we stored on the order, so
  // a receipt from "61234567", "061234567", or "+25261234567" all match. If the Oracle
  // reports an unrecognized number we keep the raw value (operator will reconcile).
  const parsed = parsePhone(senderMsisdn);
  const sender = parsed.valid ? parsed.e164 : String(senderMsisdn || '');

  // CP path: a payment must be linearizable and durable before we acknowledge it.
  const outcome = await withCriticalTransaction(async (tx) => {
    // Idempotency: if we've seen this receipt, do nothing (duplicate SMS webhook).
    const dup = await tx.transaction.findUnique({
      where: { telecom_receipt_id: receiptId },
      select: { id: true, order_id: true, matched: true },
    });
    if (dup) return { duplicate: true, transaction: dup, orderId: dup.order_id };

    // RAW, and it must stay raw: Prisma has no row-lock API. Two receipts for the same
    // amount arriving together would otherwise both read the order as PENDING_PAYMENT and
    // both try to claim it. Locking here makes the second re-read after the first commits,
    // find no pending order, and record itself as unmatched for the operator — instead of
    // blowing up and losing the receipt.
    const candidates = await tx.$queryRaw`
      SELECT id FROM orders
       WHERE user_phone = ${sender}
         AND total_amount = ${String(amount)}::numeric
         AND status = 'PENDING_PAYMENT'::order_status
       ORDER BY created_at DESC
       LIMIT 2
       FOR UPDATE
    `;

    // Ambiguous (2+) -> record but leave unmatched for the operator.
    const matchedOrderId = candidates.length === 1 ? candidates[0].id : null;

    const transaction = await tx.transaction.create({
      data: {
        order_id: matchedOrderId,
        telecom_receipt_id: receiptId,
        sender_msisdn: sender,
        amount,
        raw_sms: rawSms || null,
        matched: matchedOrderId != null,
      },
    });

    if (matchedOrderId) {
      // Same transaction: we already hold the order's row lock and know it is
      // PENDING_PAYMENT, so this transition cannot legally fail.
      await transitionOrder(matchedOrderId, STATUS.PAID_UNASSIGNED, 'system', 'payment matched', {
        client: tx,
      });
      await enqueue(tx, EVENTS.PAYMENT_RECEIVED, {
        orderId: matchedOrderId,
        amount,
        receiptId,
      });
    }

    return {
      duplicate: false,
      transaction,
      orderId: matchedOrderId,
      ambiguous: candidates.length > 1,
    };
  });

  // Committed — now let the relay push to the sockets.
  wakeOutbox();

  return outcome; // { duplicate, transaction, orderId, ambiguous }
}
