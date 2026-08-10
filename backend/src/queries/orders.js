// CQRS read side. Pure reads, no events, no writes. Shaped for the UIs that consume them.
import { query } from '../db/pool.js';

export async function getOrder(orderId) {
  const { rows } = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
  return rows[0] || null;
}

export async function getOrderTimeline(orderId) {
  const { rows } = await query(
    `SELECT from_status, to_status, actor, note, created_at
       FROM order_events WHERE order_id = $1 ORDER BY created_at ASC`,
    [orderId]
  );
  return rows;
}

export async function getMessages(orderId) {
  const { rows } = await query(
    // client_id goes to the browser so it can reconcile a message it rendered optimistically
    // while offline with the real row, instead of showing the customer their own text twice.
    `SELECT id, sender, body, client_id, created_at FROM messages
      WHERE order_id = $1 ORDER BY created_at ASC`,
    [orderId]
  );
  return rows;
}

// Driver's shopping list view for an order.
export async function getShoppingList(orderId) {
  const { rows } = await query(
    `SELECT id, items, total_amount, lat, lng, landmark_text, status, user_phone
       FROM orders WHERE id = $1`,
    [orderId]
  );
  return rows[0] || null;
}

// Resume view: a customer's orders keyed on phone, most recent first. Active (non-terminal)
// orders come first so "resume" lands on the live one.
export async function getOrdersByPhone(phone, limit = 10) {
  const { rows } = await query(
    `SELECT * FROM orders
      WHERE user_phone = $1
      ORDER BY
        (status IN ('DELIVERED','FAILED_REFUND')) ASC,  -- active first
        created_at DESC
      LIMIT $2`,
    [phone, limit]
  );
  return rows;
}

// Operator dashboard: all active (non-terminal) orders.
export async function getActiveOrders() {
  const { rows } = await query(
    `SELECT o.*, d.name AS driver_name
       FROM orders o LEFT JOIN drivers d ON d.id = o.driver_id
      WHERE o.status NOT IN ('DELIVERED', 'FAILED_REFUND')
      ORDER BY o.created_at DESC`
  );
  return rows;
}

// A driver's queue: only the orders the operator has explicitly assigned to THEM. Dispatch is
// operator-driven (no shared self-serve pool), so a driver sees just their own active jobs.
export async function getDriverQueue(driverId) {
  const { rows } = await query(
    `SELECT * FROM orders
      WHERE driver_id = $1 AND status IN ('DISPATCHED', 'IN_TRANSIT')
      ORDER BY created_at ASC`,
    [driverId]
  );
  return rows;
}

// Transactions the operator may need to reconcile manually (unmatched / ambiguous).
export async function getUnmatchedTransactions() {
  const { rows } = await query(
    `SELECT * FROM transactions WHERE matched = false ORDER BY created_at DESC LIMIT 100`
  );
  return rows;
}
