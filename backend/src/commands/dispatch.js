// Automatic dispatch (domain/dispatch.js has the rule). Operators have no driver picker: a
// paid order is assigned by the system, in the same transaction that makes it paid when a
// driver is free, otherwise as soon as one becomes free.
import { prisma, withCriticalTransaction } from '../db/prisma.js';
import { transitionOrder } from './orders.js';
import { audit } from './audit.js';
import { wakeOutbox } from '../events/outbox.js';
import { pickDriver, pickRideDriver, MAX_ACTIVE_PER_DRIVER } from '../domain/dispatch.js';
import { STATUS } from '../domain/stateMachine.js';

// One dispatcher at a time, across instances: two orders confirmed in the same instant must
// not both read "Amina has 0 jobs" and both go to her. A transaction-scoped advisory lock.
const DISPATCH_LOCK = 724001;

// Assign one PAID_UNASSIGNED order inside the caller's transaction. Returns the driver, or
// null when nobody is free (the order then waits; dispatchWaiting() picks it up).
export async function dispatchOrder(tx, orderId) {
  // $executeRaw: Prisma can't read the void this function returns.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DISPATCH_LOCK})`;
  const rows = await tx.$queryRaw`
    SELECT status, kind, vehicle, pickup_lat, pickup_lng, released_by FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
  `;
  const order = rows[0];
  if (order?.status !== STATUS.PAID_UNASSIGNED) return null;
  const released = new Set((order.released_by || []).map(String));

  // active_orders counts deliveries, active_rides rides: a driver carrying a rider gets
  // nothing else, and a rider gets a driver with nothing else.
  const candidates = await tx.$queryRaw`
    SELECT d.id, d.name, d.active, d.online, d.vehicle, (d.pin_set_at IS NOT NULL) AS ready,
           d.last_assigned_at, l.lat, l.lng, l.updated_at AS located_at,
           COUNT(o.id) FILTER (WHERE o.kind = 'DELIVERY')::int AS active_orders,
           COUNT(o.id) FILTER (WHERE o.kind = 'RIDE')::int AS active_rides
      FROM drivers d
      LEFT JOIN driver_locations l ON l.driver_id = d.id
      LEFT JOIN orders o ON o.driver_id = d.id AND o.status IN ('DISPATCHED', 'IN_TRANSIT')
     WHERE d.active
     GROUP BY d.id, l.lat, l.lng, l.updated_at
  `;
  const isRide = order.kind === 'RIDE';
  const pool = candidates.filter((d) => !released.has(String(d.id)));
  const driver = isRide
    ? pickRideDriver(pool, { pickup: { lat: order.pickup_lat, lng: order.pickup_lng }, vehicle: order.vehicle })
    : pickDriver(pool, MAX_ACTIVE_PER_DRIVER);
  if (!driver) return null;

  const now = new Date();
  await tx.order.update({ where: { id: orderId }, data: { driver_id: driver.id, updated_at: now } });
  await tx.driver.update({ where: { id: driver.id }, data: { last_assigned_at: now } });
  await transitionOrder(orderId, STATUS.DISPATCHED, 'system:dispatch', `auto-assigned to ${driver.name}`, { client: tx });
  await audit({
    actor: 'system:dispatch', action: 'order.dispatched', subject: `order:${orderId}`,
    detail: {
      driverId: String(driver.id), driver: driver.name, kind: order.kind,
      ...(isRide ? { distanceM: driver.distance_m } : { activeBefore: driver.active_orders }),
    },
  }, { client: tx });
  return driver;
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
