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
import { withTransaction } from '../db/pool.js';
import { transitionOrder } from './orders.js';
import { STATUS } from '../domain/stateMachine.js';
import { parseSomaliMsisdn } from '../domain/phone.js';
import { EVENTS } from '../events/bus.js';
import { enqueue, wakeOutbox } from '../events/outbox.js';

export async function recordAndMatchPayment({ receiptId, senderMsisdn, amount, rawSms }) {
  if (!receiptId) throw new Error('receiptId (telecom_receipt_id) required');
  // Normalize the sender to the same canonical E.164 identity we stored on the order, so
  // a receipt from "61234567", "061234567", or "+25261234567" all match. If the Oracle
  // reports an unrecognized number we keep the raw value (operator will reconcile).
  const parsed = parseSomaliMsisdn(senderMsisdn);
  const sender = parsed.valid ? parsed.e164 : String(senderMsisdn || '');

  const outcome = await withTransaction(async (client) => {
    // Idempotency: if we've seen this receipt, do nothing (duplicate SMS webhook).
    const dup = await client.query(
      'SELECT id, order_id, matched FROM transactions WHERE telecom_receipt_id = $1',
      [receiptId]
    );
    if (dup.rowCount > 0) {
      return { duplicate: true, transaction: dup.rows[0], orderId: dup.rows[0].order_id };
    }

    // Find a single pending order matching sender + amount.
    // FOR UPDATE matters: two receipts for the same amount arriving together would otherwise
    // both read the order as PENDING_PAYMENT and both try to claim it. Locking here makes the
    // second one re-read after the first commits, find no PENDING_PAYMENT order, and record
    // itself as unmatched for the operator — instead of blowing up and losing the receipt.
    const match = await client.query(
      `SELECT id FROM orders
        WHERE user_phone = $1 AND total_amount = $2 AND status = $3
        ORDER BY created_at DESC
        LIMIT 2
        FOR UPDATE`,
      [sender, amount, STATUS.PENDING_PAYMENT]
    );

    // Ambiguous (2+) -> record but leave unmatched for the operator.
    const matchedOrderId = match.rowCount === 1 ? match.rows[0].id : null;

    const { rows } = await client.query(
      `INSERT INTO transactions(order_id, telecom_receipt_id, sender_msisdn, amount, raw_sms, matched)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [matchedOrderId, receiptId, sender, amount, rawSms || null, matchedOrderId != null]
    );

    if (matchedOrderId) {
      // Same transaction: we already hold the order's row lock and know it is
      // PENDING_PAYMENT, so this transition cannot legally fail.
      await transitionOrder(matchedOrderId, STATUS.PAID_UNASSIGNED, 'system', 'payment matched', {
        client,
      });
      await enqueue(client, EVENTS.PAYMENT_RECEIVED, {
        orderId: matchedOrderId,
        amount,
        receiptId,
      });
    }

    return {
      duplicate: false,
      transaction: rows[0],
      orderId: matchedOrderId,
      ambiguous: match.rowCount > 1,
    };
  });

  // Committed — now let the relay push to the sockets.
  wakeOutbox();

  return outcome; // { duplicate, transaction, orderId, ambiguous }
}
