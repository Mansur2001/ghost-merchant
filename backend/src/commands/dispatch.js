// Automatic dispatch (domain/dispatch.js has the rule). Operators have no driver picker: a
// paid order is assigned by the system (or, for a ride, offered first to the driver the
// CUSTOMER chose — domain/offers.js), in the same transaction that makes it paid when a
// driver is free, otherwise as soon as one becomes free.
import { prisma, withCriticalTransaction } from '../db/prisma.js';
import { transitionOrder, postMessage } from './orders.js';
import { enqueue } from '../events/outbox.js';
import { EVENTS } from '../events/bus.js';
import { offerLive, wantsOffer, OFFER_TTL_MS } from '../domain/offers.js';
import { audit } from './audit.js';
import { wakeOutbox } from '../events/outbox.js';
import { pickDriver, pickRideDriver, pickTechnician, MAX_ACTIVE_PER_DRIVER } from '../domain/dispatch.js';
import { STATUS } from '../domain/stateMachine.js';

// One dispatcher at a time, across instances: two orders confirmed in the same instant must
// not both read "Amina has 0 jobs" and both go to her. A transaction-scoped advisory lock.
const DISPATCH_LOCK = 724001;

// Everyone who could take a job, with what they carry now. `has_offer` = waiting on an offer.
export async function dispatchCandidates(tx) {
  return tx.$queryRaw`
    SELECT d.id, d.name, d.active, d.online, d.vehicle, d.role, d.trades, (d.pin_set_at IS NOT NULL) AS ready,
           d.last_assigned_at, l.lat, l.lng, l.updated_at AS located_at,
           COUNT(o.id) FILTER (WHERE o.kind IN ('DELIVERY', 'PARCEL'))::int AS active_orders,
           COUNT(o.id) FILTER (WHERE o.kind = 'RIDE')::int AS active_rides,
           COUNT(o.id) FILTER (WHERE o.kind = 'SERVICE')::int AS active_services,
           EXISTS (SELECT 1 FROM orders x WHERE x.offer_driver_id = d.id AND x.offer_expires_at > now()) AS has_offer
      FROM drivers d
      LEFT JOIN driver_locations l ON l.driver_id = d.id
      LEFT JOIN orders o ON o.driver_id = d.id AND o.status IN ('DISPATCHED', 'IN_TRANSIT')
     WHERE d.active
     GROUP BY d.id, l.lat, l.lng, l.updated_at
  `;
}

async function assign(tx, orderId, driver, actor, note, detail) {
  const now = new Date();
  await tx.order.update({
    where: { id: orderId },
    data: { driver_id: driver.id, offer_driver_id: null, offer_expires_at: null, updated_at: now },
  });
  await tx.driver.update({ where: { id: driver.id }, data: { last_assigned_at: now } });
  await transitionOrder(orderId, STATUS.DISPATCHED, actor, note, { client: tx });
  await audit({
    actor, action: 'order.dispatched', subject: `order:${orderId}`,
    detail: { driverId: String(driver.id), driver: driver.name, ...detail },
  }, { client: tx });
}

// Assign one PAID_UNASSIGNED order inside the caller's transaction. Returns the driver, or
// null when nobody is free (the order then waits; dispatchWaiting() picks it up) or when the
// driver the customer chose has been OFFERED it (domain/offers.js) and has 30 s to answer.
export async function dispatchOrder(tx, orderId) {
  // $executeRaw: Prisma can't read the void this function returns.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DISPATCH_LOCK})`;
  const rows = await tx.$queryRaw`
    SELECT id, status, kind, vehicle, lat, lng, pickup_lat, pickup_lng, released_by, trade, parent_order_id,
           requested_driver_id, offer_driver_id, offer_expires_at
      FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
  `;
  const order = rows[0];
  if (order?.status !== STATUS.PAID_UNASSIGNED) return null;
  // Someone is deciding: let them. And an offer whose time is up but which the sweep hasn't
  // closed yet is the sweep's to close (it records it and moves on) — dispatching it here would
  // offer the same driver a fresh 30 s and keep the rider waiting.
  if (order.offer_driver_id != null) return null;
  const released = new Set((order.released_by || []).map(String));
  const candidates = await dispatchCandidates(tx);
  const pool = candidates.filter((d) => !released.has(String(d.id)));

  // Extra work goes to the technician who quoted it and is standing in the house: no rotation.
  if (order.parent_order_id && order.requested_driver_id != null) {
    const tech = candidates.find((d) => String(d.id) === String(order.requested_driver_id));
    if (tech?.active) {
      await assign(tx, orderId, tech, 'system:dispatch', `extra work for ${tech.name}`, { kind: order.kind, extraWork: true });
      return tech;
    }
  }

  if (order.kind === 'RIDE') {
    const pickup = { lat: order.pickup_lat, lng: order.pickup_lng };
    if (wantsOffer(order)) {
      const chosen = pool.find((d) => String(d.id) === String(order.requested_driver_id));
      // Still free, online, in the right vehicle and near: offer it. Otherwise straight on.
      const ok = chosen && pickRideDriver([chosen], { pickup, vehicle: order.vehicle });
      if (ok) {
        const expires = new Date(Date.now() + OFFER_TTL_MS);
        await tx.order.update({
          where: { id: orderId }, data: { offer_driver_id: chosen.id, offer_expires_at: expires, updated_at: new Date() },
        });
        await enqueue(tx, EVENTS.DRIVER_OFFERED, {
          orderId, driverId: String(chosen.id), expiresAt: expires.toISOString(), status: STATUS.PAID_UNASSIGNED,
        });
        await audit({
          actor: 'system:dispatch', action: 'order.offered', subject: `order:${orderId}`,
          detail: { driverId: String(chosen.id), driver: chosen.name, distanceM: ok.distance_m },
        }, { client: tx });
        return null;
      }
    }
    const driver = pickRideDriver(pool, { pickup, vehicle: order.vehicle });
    if (!driver) return null;
    await assign(tx, orderId, driver, 'system:dispatch', `auto-assigned to ${driver.name}`, { kind: order.kind, distanceM: driver.distance_m });
    return driver;
  }

  if (order.kind === 'SERVICE') {
    const tech = pickTechnician(pool, { trade: order.trade, site: { lat: order.lat, lng: order.lng } });
    if (!tech) return null;
    await assign(tx, orderId, tech, 'system:dispatch', `auto-assigned to ${tech.name}`, { kind: order.kind, trade: order.trade, distanceM: tech.distance_m });
    return tech;
  }

  const driver = pickDriver(pool, MAX_ACTIVE_PER_DRIVER);
  if (!driver) return null;
  await assign(tx, orderId, driver, 'system:dispatch', `auto-assigned to ${driver.name}`, { kind: order.kind, activeBefore: driver.active_orders });
  return driver;
}

// ── Offers (domain/offers.js) ──

// The chosen driver takes it. Only while the offer is theirs and live.
export async function acceptOffer({ orderId, driverId }) {
  const result = await withCriticalTransaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DISPATCH_LOCK})`;
    const rows = await tx.$queryRaw`
      SELECT id, status, offer_driver_id, offer_expires_at FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
    `;
    const row = rows[0];
    // Not yours, or never was: the same answer as "no such order" (deny = 404).
    if (!row || String(row.offer_driver_id) !== String(driverId)) return { error: 'not found', status: 404 };
    if (row.status !== STATUS.PAID_UNASSIGNED || !offerLive(row)) return { error: 'this request has expired', status: 409 };
    const driver = await tx.driver.findUnique({ where: { id: BigInt(driverId) }, select: { id: true, name: true, active: true } });
    if (!driver?.active) return { error: 'not found', status: 404 };
    await assign(tx, orderId, driver, `driver:${driverId}`, `${driver.name} accepted the rider's request`, { kind: 'RIDE', chosenByCustomer: true });
    return { ok: true };
  });
  wakeOutbox();
  return result;
}

// Close an offer (declined, or time ran out) and dispatch automatically, in one transaction.
async function closeOffer(tx, orderId, driverId, why) {
  await tx.$executeRaw`
    UPDATE orders SET offer_driver_id = NULL, offer_expires_at = NULL,
           released_by = array_append(released_by, ${BigInt(driverId)}), updated_at = now()
     WHERE id = ${orderId}::uuid
  `;
  await audit({
    actor: why === 'declined' ? `driver:${driverId}` : 'system:dispatch',
    action: `order.offer_${why}`, subject: `order:${orderId}`, detail: { driverId: String(driverId) },
  }, { client: tx });
  await postMessage({
    orderId, sender: 'system',
    body: 'The driver you chose could not take this ride. We are sending the nearest free driver.',
  }, { client: tx });
  await enqueue(tx, EVENTS.DRIVER_OFFERED, { orderId, driverId: String(driverId), closed: why, status: STATUS.PAID_UNASSIGNED });
  return dispatchOrder(tx, orderId);
}

export async function declineOffer({ orderId, driverId }) {
  const result = await withCriticalTransaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT id, status, offer_driver_id, offer_expires_at FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
    `;
    const row = rows[0];
    if (!row || String(row.offer_driver_id) !== String(driverId)) return { error: 'not found', status: 404 };
    await closeOffer(tx, orderId, driverId, 'declined');
    return { ok: true };
  });
  wakeOutbox();
  return result;
}

// Offers whose 30 s are up go to automatic dispatch. On a timer (index.js), every few seconds.
export async function expireOffers(now = new Date()) {
  const due = await prisma.order.findMany({
    where: { status: STATUS.PAID_UNASSIGNED, offer_driver_id: { not: null }, offer_expires_at: { lte: now } },
    select: { id: true }, take: 50,
  });
  let n = 0;
  for (const { id } of due) {
    // eslint-disable-next-line no-await-in-loop
    await withCriticalTransaction(async (tx) => {
      const rows = await tx.$queryRaw`
        SELECT offer_driver_id, offer_expires_at FROM orders WHERE id = ${id}::uuid FOR UPDATE
      `;
      // Accepted or declined in the meantime: nothing to do.
      if (!rows[0]?.offer_driver_id || new Date(rows[0].offer_expires_at) > new Date()) return;
      await closeOffer(tx, id, rows[0].offer_driver_id, 'expired');
      n += 1;
    });
  }
  if (n) wakeOutbox();
  return n;
}

// Give every waiting order a driver, oldest first, until drivers run out. Called when a driver
// frees up (delivered, failed, set up, reactivated) and on a timer as a backstop.
export async function dispatchWaiting() {
  const waiting = await prisma.order.findMany({
    where: { status: STATUS.PAID_UNASSIGNED },
    orderBy: { created_at: 'asc' },
    select: { id: true },
    take: 50,
  });
  let assigned = 0;
  for (const { id } of waiting) {
    // eslint-disable-next-line no-await-in-loop
    const driver = await withCriticalTransaction((tx) => dispatchOrder(tx, id));
    // No break on a miss: a ride with no bajaj nearby must not hold up a delivery behind it.
    if (driver) assigned += 1;
  }
  if (assigned) wakeOutbox();
  return assigned;
}

// Fire-and-forget after a driver frees up: the request that freed them must not wait on it.
export function dispatchWaitingSoon() {
  dispatchWaiting().catch((err) => console.error('[dispatch] waiting orders:', err.message));
}

// The assigned driver gives a job back before pickup. It goes back to PAID_UNASSIGNED with
// them on `released_by`, and is re-dispatched in the same transaction when someone else is
// free. Audited: a driver who releases everything far away is visible to the owner.
export async function releaseOrder({ orderId, driverId, reason }) {
  const result = await withCriticalTransaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT status, driver_id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
    `;
    const row = rows[0];
    if (!row || String(row.driver_id) !== String(driverId)) return { error: 'not found', status: 404 };
    if (row.status !== STATUS.DISPATCHED) return { error: 'you can only give a job back before pickup', status: 409 };
    await tx.$executeRaw`
      UPDATE orders SET driver_id = NULL, released_by = array_append(released_by, ${BigInt(driverId)}),
             updated_at = now()
       WHERE id = ${orderId}::uuid
    `;
    await transitionOrder(orderId, STATUS.PAID_UNASSIGNED, `driver:${driverId}`, `released: ${reason}`, { client: tx });
    await audit({
      actor: `driver:${driverId}`, action: 'order.released', subject: `order:${orderId}`, detail: { reason },
    }, { client: tx });
    const next = await dispatchOrder(tx, orderId);
    return { ok: true, redispatched: Boolean(next) };
  });
  wakeOutbox();
  return result;
}
