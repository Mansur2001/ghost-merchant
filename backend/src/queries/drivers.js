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
      select: {
        id: true, name: true, msisdn: true, active: true, pin_set_at: true, email: true,
        vehicle: true, online: true, location: { select: { updated_at: true } },
      },
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
  // Only whether an email is on file (so "re-send" can say where it goes), not the address.
  return drivers.map(({ email, location, ...d }) => ({
    ...d,
    has_email: Boolean(email),
    located_at: location?.updated_at ?? null,
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

// The driver's own switch and vehicle, for their app.
export async function getDriverSelf(id) {
  return prisma.driver.findUnique({
    where: { id: BigInt(id) },
    select: { id: true, name: true, vehicle: true, online: true },
  });
}

// The operator's live map: every active driver with a known position, and what they carry.
// Positions older than a day are dropped — a dot from last week is misinformation.
export async function getDriverPositions() {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const rows = await prisma.driverLocation.findMany({
    where: { updated_at: { gte: since }, driver: { active: true } },
    select: {
      driver_id: true, lat: true, lng: true, accuracy_m: true, heading: true, updated_at: true,
      driver: {
        select: {
          name: true, vehicle: true, online: true,
          orders: { where: { status: { in: ['DISPATCHED', 'IN_TRANSIT'] } }, select: { id: true, kind: true, status: true } },
        },
      },
    },
  });
  return rows.map(({ driver, ...l }) => ({
    ...l, name: driver.name, vehicle: driver.vehicle, online: driver.online, jobs: driver.orders,
  }));
}

// The assigned driver's dot for a customer: position, name and vehicle — no phone, no history.
export async function getDriverLocationForOrder(driverId) {
  const l = await prisma.driverLocation.findUnique({
    where: { driver_id: BigInt(driverId) },
    select: { lat: true, lng: true, accuracy_m: true, heading: true, updated_at: true, driver: { select: { name: true, vehicle: true } } },
  });
  if (!l) return null;
  return { lat: l.lat, lng: l.lng, accuracy: l.accuracy_m, heading: l.heading, at: l.updated_at, name: l.driver.name, vehicle: l.driver.vehicle };
}
