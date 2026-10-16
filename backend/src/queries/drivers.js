// CQRS read side for drivers. Powers the operator's assignment picker + driver stats panel.
import { prisma } from '../db/prisma.js';

// All drivers with their current workload (active = dispatched or in-transit).
//
// Prisma has no conditional aggregate (`count(*) FILTER (WHERE ...)`), so the two counts come
// from grouped queries rather than one join. The roster is a handful of rows — the clarity is
// worth more here than saving two round trips.
export async function getDriversWithStats() {
  const [drivers, active, delivered] = await Promise.all([
    prisma.driver.findMany({
      select: { id: true, name: true, msisdn: true, active: true, pin_set_at: true },
      orderBy: { name: 'asc' },
    }),
    prisma.order.groupBy({
      by: ['driver_id'],
      where: { status: { in: ['DISPATCHED', 'IN_TRANSIT'] }, driver_id: { not: null } },
      _count: { _all: true },
    }),
    prisma.order.groupBy({
      by: ['driver_id'],
      where: { status: 'DELIVERED', driver_id: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const tally = (rows) =>
    new Map(rows.map((r) => [String(r.driver_id), r._count._all]));
  const activeBy = tally(active);
  const deliveredBy = tally(delivered);

  // The dashboard renders these as numbers; pg returned them as counts, so keep that.
  return drivers.map((d) => ({
    ...d,
    // An invited driver who hasn't chosen a PIN yet can't sign in — the desk needs to see that.
    setup_pending: d.pin_set_at === null,
    active_orders: activeBy.get(String(d.id)) ?? 0,
    delivered_orders: deliveredBy.get(String(d.id)) ?? 0,
  }));
}

export async function getDriverById(id) {
  // Ids arrive from JSON as strings or numbers; the column is BIGINT.
  let key;
  try {
    key = BigInt(id);
  } catch {
    return null; // not a number at all — same answer as "no such driver"
  }
  return prisma.driver.findUnique({
    where: { id: key },
    select: { id: true, name: true, msisdn: true, active: true, pin_set_at: true },
  });
}
