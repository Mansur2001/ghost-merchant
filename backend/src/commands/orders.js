// CQRS write side for orders. Every write goes through here, records a domain event in the
// SAME transaction as the state change (events/outbox.js), and — for status changes — is
// validated by the state machine and recorded in the audit log.
//
// Events are no longer published directly from here. `publish()` after `COMMIT` is two steps
// with a crash-shaped gap between them; the outbox closes it. Commands enqueue, then call
// wakeOutbox() after the transaction returns so the relay delivers immediately.
import { withTransaction, inTransaction, query } from '../db/pool.js';
import { assertTransition, AUTO_RESPONSES } from '../domain/stateMachine.js';
import { normalizeMsisdnOrThrow } from '../domain/phone.js';
import { EVENTS } from '../events/bus.js';
import { isUuid, newOrderId } from '../domain/ids.js';
import { enqueue, wakeOutbox } from '../events/outbox.js';

// Create an order (and the user, if new). Returns { order, created }.
//
// `id` may be supplied by the client (a UUID it minted itself). That makes creation
// IDEMPOTENT: a flaky mobile connection that retries a request whose response was lost gets
// the original order back instead of silently creating a second one the customer then pays
// for twice. It is also the mechanism the offline write queue (P2) will use.
//
// The client chooses the id, never the owner: the phone still comes from the verified session.
export async function createOrder({ id, userPhone, items, totalAmount, lat, lng, landmark }) {
  if (!userPhone) throw new Error('userPhone required');
  if (!landmark || !landmark.trim()) throw new Error('landmark is mandatory');
  if (id != null && !isUuid(id)) throw new Error('id must be a UUID');
  // Enforce the phone rules server-side; store canonical E.164 as the identity.
  const phone = normalizeMsisdnOrThrow(userPhone);
  const orderId = id || newOrderId();

  const result = await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO users(phone_number) VALUES ($1)
       ON CONFLICT (phone_number) DO NOTHING`,
      [phone]
    );
    const { rows } = await client.query(
      `INSERT INTO orders(id, user_phone, items, total_amount, lat, lng, landmark_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [orderId, phone, JSON.stringify(items || []), totalAmount, lat, lng, landmark]
    );

    // Conflict: this id already exists, so it's a retry. Return the existing order — but only
    // to its owner. Otherwise supplying someone else's order id would leak their order.
    if (rows.length === 0) {
      const { rows: existing } = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      if (!existing[0] || existing[0].user_phone !== phone) {
        throw new Error('id already in use');
      }
      return { order: existing[0], created: false };
    }

    const created = rows[0];
    await client.query(
      `INSERT INTO order_events(order_id, from_status, to_status, actor, note)
       VALUES ($1, NULL, 'PENDING_PAYMENT', 'system', 'order created')`,
      [created.id]
    );
    await enqueue(client, EVENTS.ORDER_CREATED, { orderId: created.id, order: created });
    return { order: created, created: true };
  });

  // A retry produced no new state, so there is nothing new to deliver.
  if (result.created) wakeOutbox();
  return result;
}

// Transition an order's status. The ONLY path allowed to change orders.status.
// `actor` is 'system' | 'operator:<id>:<username>' | 'driver:<id>'.
//
// Pass `client` to enlist in an existing transaction — payment matching does this so the
// receipt, the transition and both events commit as one unit.
export async function transitionOrder(orderId, toStatus, actor = 'system', note = null, { client } = {}) {
  const result = await inTransaction(client, async (tx) => {
    // Lock the row so concurrent transitions can't race.
    const { rows } = await tx.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = rows[0];
    if (!order) throw new Error(`order ${orderId} not found`);

    assertTransition(order.status, toStatus); // throws on illegal transition

    const { rows: updated } = await tx.query(
      `UPDATE orders SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [toStatus, orderId]
    );
    await tx.query(
      `INSERT INTO order_events(order_id, from_status, to_status, actor, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, order.status, toStatus, actor, note]
    );
    await enqueue(tx, EVENTS.ORDER_STATE_CHANGED, {
      orderId,
      from: order.status,
      to: toStatus,
      actor,
    });

    // The state-driven auto-response belongs to the same commit: a customer must never see
    // the status move without the message explaining it, or vice versa.
    const auto = AUTO_RESPONSES[toStatus];
    if (auto) await postMessage({ orderId, sender: 'system', body: auto }, { client: tx });

    return { previous: order, order: updated[0] };
  });

  // If we're nested inside someone else's transaction, THEY wake the relay after committing —
  // waking now would publish an event that isn't committed yet.
  if (!client) wakeOutbox();
  return result.order;
}

// Assign a driver (does not itself change status; pairs with a DISPATCHED transition).
export async function assignDriver(orderId, driverId, { client } = {}) {
  const run = (tx) =>
    tx.query('UPDATE orders SET driver_id = $1, updated_at = now() WHERE id = $2', [
      driverId,
      orderId,
    ]);
  return client ? run(client) : run({ query });
}

// Post a chat/timeline message. Accepts an existing transaction client so it can be part of
// a larger atomic change (see transitionOrder).
//
// `clientId` is an optional client-minted UUID that makes the write idempotent. The offline
// queue replays messages when the network returns, and without it a message whose response
// was lost is re-sent and appears twice — the customer sees themselves stutter, and the
// transcript is wrong in exactly the situation (a dispute) where it matters most.
export async function postMessage({ orderId, sender, body, clientId }, { client } = {}) {
  if (clientId != null && !isUuid(clientId)) throw new Error('clientId must be a UUID');

  const result = await inTransaction(client, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO messages(order_id, sender, body, client_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (client_id) WHERE client_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [orderId, sender, body, clientId ?? null]
    );

    // Conflict: this exact message already landed, so this is a replay. Return the original
    // and emit nothing — re-broadcasting would push a duplicate into every open thread.
    if (rows.length === 0) {
      const { rows: existing } = await tx.query('SELECT * FROM messages WHERE client_id = $1', [
        clientId,
      ]);
      return { message: existing[0], created: false };
    }

    await enqueue(tx, EVENTS.MESSAGE_POSTED, { orderId, message: rows[0] });
    return { message: rows[0], created: true };
  });

  if (!client && result.created) wakeOutbox();
  return result.message;
}
