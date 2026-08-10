// CQRS write side for orders. Every write goes through here, records a domain event in the
// SAME transaction as the state change (events/outbox.js), and — for status changes — is
// validated by the state machine and recorded in the audit log.
//
// Events are never published directly from here. `publish()` after `COMMIT` is two steps with
// a crash-shaped gap between them; the outbox closes it. Commands enqueue, then call
// wakeOutbox() after the transaction returns so the relay delivers immediately.
//
// WHERE RAW SQL SURVIVES THE PRISMA MIGRATION, and why:
//   * `SELECT ... FOR UPDATE` — Prisma has no row-lock API. Without the lock, two concurrent
//     transitions both read the old status and both pass the state-machine check.
//   * conditional `ON CONFLICT ... DO NOTHING` against a PARTIAL unique index — Prisma's
//     upsert can't target one, and that index is what makes offline replay idempotent.
import { prisma, withCriticalTransaction, inTransaction } from '../db/prisma.js';
import { assertTransition, AUTO_RESPONSES } from '../domain/stateMachine.js';
import { normalizeMsisdnOrThrow } from '../domain/phone.js';
import { EVENTS } from '../events/bus.js';
import { isUuid, newOrderId } from '../domain/ids.js';
import { enqueue, wakeOutbox } from '../events/outbox.js';
import { openRefundIfOwed } from './refunds.js';

// Create an order (and the user, if new). Returns { order, created }.
//
// `id` may be supplied by the client (a UUID it minted itself). That makes creation
// IDEMPOTENT: a flaky mobile connection that retries a request whose response was lost gets
// the original order back instead of silently creating a second one the customer then pays
// for twice. It is also what the offline write queue relies on.
//
// The client chooses the id, never the owner: the phone still comes from the verified session.
export async function createOrder({ id, userPhone, items, totalAmount, lat, lng, landmark }) {
  if (!userPhone) throw new Error('userPhone required');
  if (!landmark || !landmark.trim()) throw new Error('landmark is mandatory');
  if (id != null && !isUuid(id)) throw new Error('id must be a UUID');
  const phone = normalizeMsisdnOrThrow(userPhone);
  const orderId = id || newOrderId();

  // CP path: an order is what every other write hangs off, so it must be durable before the
  // customer is told it exists and asked to pay for it.
  const result = await withCriticalTransaction(async (tx) => {
    await tx.user.upsert({
      where: { phone_number: phone },
      update: {},
      create: { phone_number: phone },
    });

    const existing = await tx.order.findUnique({ where: { id: orderId } });
    if (existing) {
      // A retry. Return the original — but only to its owner, or supplying someone else's
      // order id would leak their order.
      if (existing.user_phone !== phone) throw new Error('id already in use');
      return { order: existing, created: false };
    }

    const created = await tx.order.create({
      data: {
        id: orderId,
        user_phone: phone,
        items: items || [],
        total_amount: totalAmount,
        lat: lat ?? null,
        lng: lng ?? null,
        landmark_text: landmark,
      },
    });

    await tx.orderEvent.create({
      data: {
        order_id: created.id,
        from_status: null,
        to_status: 'PENDING_PAYMENT',
        actor: 'system',
        note: 'order created',
      },
    });
    await enqueue(tx, EVENTS.ORDER_CREATED, { orderId: created.id, order: created });
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
  // CP path: order state is the single source of truth, so a transition is acknowledged only
  // once it is durable. When nested in a caller's transaction, that caller chose the level.
  const run = client ? (fn) => fn(client) : withCriticalTransaction;

  const result = await run(async (tx) => {
    // RAW, and it must stay raw: Prisma has no row-lock API. Without FOR UPDATE two
    // concurrent transitions both read the old status, both pass assertTransition, and the
    // second silently overwrites the first — an order could go DELIVERED then IN_TRANSIT.
    const locked = await tx.$queryRaw`
      SELECT id, status FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
    `;
    const order = locked[0];
    if (!order) throw new Error(`order ${orderId} not found`);

    assertTransition(order.status, toStatus); // throws on illegal transition

    const updated = await tx.order.update({
      where: { id: orderId },
      data: { status: toStatus, updated_at: new Date() },
    });
    await tx.orderEvent.create({
      data: { order_id: orderId, from_status: order.status, to_status: toStatus, actor, note },
    });
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

    // Failing an order that was already paid means we owe the customer money. Open the debt
    // in the SAME transaction — an order must never be able to end up failed with no record
    // of what is owed, because that record is the only thing that will remind anyone to pay
    // it back.
    if (toStatus === 'FAILED_REFUND') {
      await openRefundIfOwed({ orderId, reason: note, createdBy: actor }, { client: tx });
    }

    return { previous: order, order: updated };
  });

  // If we're nested inside someone else's transaction, THEY wake the relay after committing —
  // waking now would publish an event that isn't committed yet.
  if (!client) wakeOutbox();
  return result.order;
}

// Assign a driver (does not itself change status; pairs with a DISPATCHED transition).
export async function assignDriver(orderId, driverId, { client } = {}) {
  const db = client || prisma;
  return db.order.update({
    where: { id: orderId },
    data: { driver_id: BigInt(driverId), updated_at: new Date() },
  });
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
    // RAW, and it must stay raw: the uniqueness lives in a PARTIAL index
    // (`WHERE client_id IS NOT NULL`), which Prisma's upsert cannot target. Doing a
    // find-then-create instead would race two replays into two rows.
    const inserted = await tx.$queryRaw`
      INSERT INTO messages(order_id, sender, body, client_id)
      VALUES (${orderId}::uuid, ${sender}, ${body}, ${clientId ?? null}::uuid)
      ON CONFLICT (client_id) WHERE client_id IS NOT NULL DO NOTHING
      RETURNING *
    `;

    // Conflict: this exact message already landed, so this is a replay. Return the original
    // and emit nothing — re-broadcasting would push a duplicate into every open thread.
    if (inserted.length === 0) {
      const existing = await tx.message.findFirst({ where: { client_id: clientId } });
      return { message: existing, created: false };
    }

    const message = inserted[0];
    await enqueue(tx, EVENTS.MESSAGE_POSTED, { orderId, message });
    return { message, created: true };
  });

  if (!client && result.created) wakeOutbox();
  return result.message;
}
