// Automatic dispatch (domain/dispatch.js has the rule). Operators have no driver picker: a
// paid order is assigned by the system, in the same transaction that makes it paid when a
// driver is free, otherwise as soon as one becomes free.
import { prisma, withCriticalTransaction } from '../db/prisma.js';
import { transitionOrder } from './orders.js';
import { audit } from './audit.js';
import { wakeOutbox } from '../events/outbox.js';
import { pickDriver, MAX_ACTIVE_PER_DRIVER } from '../domain/dispatch.js';
import { STATUS } from '../domain/stateMachine.js';

// One dispatcher at a time, across instances: two orders confirmed in the same instant must
// not both read "Amina has 0 jobs" and both go to her. A transaction-scoped advisory lock.
const DISPATCH_LOCK = 724001;

// Assign one PAID_UNASSIGNED order inside the caller's transaction. Returns the driver, or
// null when nobody is free (the order then waits; dispatchWaiting() picks it up).
export async function dispatchOrder(tx, orderId) {
  // $executeRaw: Prisma can't read the void this function returns.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DISPATCH_LOCK})`;
  const rows = await tx.$queryRaw`SELECT status FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  if (rows[0]?.status !== STATUS.PAID_UNASSIGNED) return null;

  const candidates = await tx.$queryRaw`
    SELECT d.id, d.name, d.active, (d.pin_set_at IS NOT NULL) AS ready, d.last_assigned_at,
           COUNT(o.id)::int AS active_orders
      FROM drivers d
      LEFT JOIN orders o ON o.driver_id = d.id AND o.status IN ('DISPATCHED', 'IN_TRANSIT')
     WHERE d.active
     GROUP BY d.id
  `;
  const driver = pickDriver(candidates, MAX_ACTIVE_PER_DRIVER);
  if (!driver) return null;

  const now = new Date();
  await tx.order.update({ where: { id: orderId }, data: { driver_id: driver.id, updated_at: now } });
  await tx.driver.update({ where: { id: driver.id }, data: { last_assigned_at: now } });
  await transitionOrder(orderId, STATUS.DISPATCHED, 'system:dispatch', `auto-assigned to ${driver.name}`, { client: tx });
  await audit({
    actor: 'system:dispatch', action: 'order.dispatched', subject: `order:${orderId}`,
    detail: { driverId: String(driver.id), driver: driver.name, activeBefore: driver.active_orders },
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
    if (!driver) break; // nobody free: the rest wait too
    assigned += 1;
  }
  if (assigned) wakeOutbox();
  return assigned;
}

// Fire-and-forget after a driver frees up: the request that freed them must not wait on it.
export function dispatchWaitingSoon() {
  dispatchWaiting().catch((err) => console.error('[dispatch] waiting orders:', err.message));
}
