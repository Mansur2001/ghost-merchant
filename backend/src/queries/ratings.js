// Read side for ratings: a driver's average, as customers see it before choosing.
import { prisma } from '../db/prisma.js';

// Map of driver id -> { avg (one decimal), count }. Drivers with no rating are absent.
export async function driverRatings(ids) {
  const keys = [...new Set(ids.map(String))].map((id) => BigInt(id));
  if (!keys.length) return new Map();
  const rows = await prisma.rating.groupBy({
    by: ['driver_id'], where: { driver_id: { in: keys } }, _avg: { stars: true }, _count: { _all: true },
  });
  return new Map(rows.map((r) => [String(r.driver_id), {
    avg: Math.round((r._avg.stars ?? 0) * 10) / 10, count: r._count._all,
  }]));
}

export async function getRating(orderId) {
  return prisma.rating.findUnique({ where: { order_id: orderId }, select: { stars: true, comment: true, created_at: true } });
}
