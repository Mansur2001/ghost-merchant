// CQRS read side. Pure reads, no events, no writes. Shaped for the UIs that consume them.
import { prisma } from '../db/prisma.js';

export async function getOrder(orderId) {
  return prisma.order.findUnique({ where: { id: orderId } });
}

export async function getOrderTimeline(orderId) {
  return prisma.orderEvent.findMany({
    where: { order_id: orderId },
    select: { from_status: true, to_status: true, actor: true, note: true, created_at: true },
    orderBy: { created_at: 'asc' },
  });
}

export async function getMessages(orderId) {
  return prisma.message.findMany({
    where: { order_id: orderId },
    // client_id goes to the browser so it can reconcile a message it rendered optimistically
    // while offline with the real row, instead of showing the customer their own text twice.
    select: { id: true, sender: true, body: true, client_id: true, created_at: true },
    orderBy: { created_at: 'asc' },
  });
}

// The customer's delivery code. Only ever called for the order's own customer (the route is
// customerOnly + requireOrderAccess): the driver must hear it from them, not read it.
export async function getHandoff(orderId) {
  return prisma.deliveryHandoff.findUnique({
    where: { order_id: orderId },
    select: { code: true, verified_at: true },
  });
}

// The evidence behind an order's driver steps. No handoff code in here — only how the step
// was proven — so it is safe for everyone who may see the order.
export async function getProofs(orderId) {
  return prisma.orderProof.findMany({
    where: { order_id: orderId },
    select: {
      step: true, method: true, note: true, distance_m: true, accuracy_m: true, flags: true,
      created_at: true, reviewed_by: true, reviewed_at: true,
    },
    orderBy: { created_at: 'asc' },
  });
}

// Recent deliveries for the operator's review screen, flagged and unchecked ones first.
// Seven days is the window a customer realistically disputes in.
export async function getRecentDeliveries({ days = 7, limit = 100 } = {}) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const proofs = await prisma.orderProof.findMany({
    where: { step: 'delivery', created_at: { gte: since } },
    orderBy: { created_at: 'desc' },
    take: limit,
    include: {
      order: {
        select: {
          id: true, total_amount: true, landmark_text: true, user_phone: true, lat: true, lng: true,
          driver: { select: { name: true } },
        },
      },
    },
  });
  const needsLook = (p) => p.flags.length > 0 && !p.reviewed_at;
  return proofs
    .map(({ order: { driver, ...order }, ...p }) => ({ ...p, order: { ...order, driver_name: driver?.name ?? null } }))
    .sort((a, b) => needsLook(b) - needsLook(a));
}

// Driver's shopping list view for an order.
export async function getShoppingList(orderId) {
  return prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, items: true, total_amount: true, lat: true, lng: true,
      landmark_text: true, status: true, user_phone: true,
    },
  });
}

// Resume view: a customer's orders, by account, most recent first. Active (non-terminal)
// orders come first so "resume" lands on the live one.
//
// Prisma can't express "ORDER BY (status IN (...)) ASC", so the two groups are fetched
// separately. Two indexed queries beat a raw string the schema can't see through, and a
// customer has a handful of orders, not thousands.
export async function getOrdersByUser(userId, limit = 10) {
  // Prisma reads an undefined filter as no filter: that would be every customer's orders.
  if (!Number.isInteger(userId)) throw new Error('userId required');
  const TERMINAL = ['DELIVERED', 'FAILED_REFUND'];
  const active = await prisma.order.findMany({
    where: { user_id: userId, status: { notIn: TERMINAL } },
    orderBy: { created_at: 'desc' },
    take: limit,
  });
  if (active.length >= limit) return active;

  const done = await prisma.order.findMany({
    where: { user_id: userId, status: { in: TERMINAL } },
    orderBy: { created_at: 'desc' },
    take: limit - active.length,
  });
  return [...active, ...done];
}

// Operator dashboard: all active (non-terminal) orders, with the driver's name attached.
export async function getActiveOrders() {
  const orders = await prisma.order.findMany({
    where: { status: { notIn: ['DELIVERED', 'FAILED_REFUND'] } },
    orderBy: { created_at: 'desc' },
    include: { driver: { select: { name: true } } },
  });
  // The dashboard reads `driver_name`; keep that shape rather than changing the client.
  return orders.map(({ driver, ...order }) => ({ ...order, driver_name: driver?.name ?? null }));
}

// A driver's queue: only the orders the operator has explicitly assigned to THEM. Dispatch is
// operator-driven (no shared self-serve pool), so a driver sees just their own active jobs.
export async function getDriverQueue(driverId) {
  return prisma.order.findMany({
    where: { driver_id: BigInt(driverId), status: { in: ['DISPATCHED', 'IN_TRANSIT'] } },
    orderBy: { created_at: 'asc' },
  });
}

// Transactions the operator may need to reconcile manually (unmatched / ambiguous).
