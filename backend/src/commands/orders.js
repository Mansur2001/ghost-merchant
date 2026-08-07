// CQRS write side for orders. Every write goes through here, emits a domain event, and
// (for status changes) is validated by the state machine + recorded in the audit log.
import { withTransaction, query } from '../db/pool.js';
import { assertTransition, AUTO_RESPONSES } from '../domain/stateMachine.js';
import { normalizeMsisdnOrThrow } from '../domain/phone.js';
import { EVENTS, publish } from '../events/bus.js';

// Create an order (and the user, if new). Returns the created order row.
export async function createOrder({ userPhone, items, totalAmount, lat, lng, landmark }) {
  if (!userPhone) throw new Error('userPhone required');
  if (!landmark || !landmark.trim()) throw new Error('landmark is mandatory');
  // Enforce the Somali-number rule server-side; store canonical E.164 as the identity.
  const phone = normalizeMsisdnOrThrow(userPhone);

  const order = await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO users(phone_number) VALUES ($1)
       ON CONFLICT (phone_number) DO NOTHING`,
      [phone]
    );
    const { rows } = await client.query(
      `INSERT INTO orders(user_phone, items, total_amount, lat, lng, landmark_text)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [phone, JSON.stringify(items || []), totalAmount, lat, lng, landmark]
    );
    const created = rows[0];
    await client.query(
      `INSERT INTO order_events(order_id, from_status, to_status, actor, note)
       VALUES ($1, NULL, 'PENDING_PAYMENT', 'system', 'order created')`,
      [created.id]
    );
    return created;
  });

  publish(EVENTS.ORDER_CREATED, { orderId: order.id, order });
  return order;
}

// Transition an order's status. The ONLY path allowed to change orders.status.
// `actor` is 'system' | 'operator:<id>' | 'driver:<id>'.
export async function transitionOrder(orderId, toStatus, actor = 'system', note = null) {
  const result = await withTransaction(async (client) => {
    // Lock the row so concurrent transitions can't race.
    const { rows } = await client.query(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
      [orderId]
    );
    const order = rows[0];
    if (!order) throw new Error(`order ${orderId} not found`);

    assertTransition(order.status, toStatus); // throws on illegal transition

    const { rows: updated } = await client.query(
      `UPDATE orders SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [toStatus, orderId]
    );
    await client.query(
      `INSERT INTO order_events(order_id, from_status, to_status, actor, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId, order.status, toStatus, actor, note]
    );
    return { previous: order, order: updated[0] };
  });

  publish(EVENTS.ORDER_STATE_CHANGED, {
    orderId,
    from: result.previous.status,
    to: toStatus,
    actor,
  });

  // Fire the state-driven auto-response into the chat thread (Option A).
  const auto = AUTO_RESPONSES[toStatus];
  if (auto) await postMessage({ orderId, sender: 'system', body: auto });

  return result.order;
}

// Assign a driver (does not itself change status; pairs with a DISPATCHED transition).
export async function assignDriver(orderId, driverId) {
  await query('UPDATE orders SET driver_id = $1, updated_at = now() WHERE id = $2', [
    driverId,
    orderId,
  ]);
}

// Post a chat/timeline message and broadcast it.
export async function postMessage({ orderId, sender, body }) {
  const { rows } = await query(
    `INSERT INTO messages(order_id, sender, body) VALUES ($1, $2, $3) RETURNING *`,
    [orderId, sender, body]
  );
  const message = rows[0];
  publish(EVENTS.MESSAGE_POSTED, { orderId, message });
  return message;
}
