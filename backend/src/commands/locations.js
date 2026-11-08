// Drivers' live positions and their online switch.
//
// A position is TELEMETRY, not a domain event: it goes straight to the bus (TELEMETRY in
// events/bus.js), never through the outbox, and only the latest one per driver is kept
// (driver_locations). Losing one costs nothing — the next arrives seconds later — and keeping
// a trail would be a record of where people go that we have no use for. The fix that proves a
// step is stored separately, on order_proofs, with the step.
import { prisma } from '../db/prisma.js';
import { publish, TELEMETRY } from '../events/bus.js';
import { parseFix } from '../domain/proof.js';
import { inServiceArea } from '../domain/geo.js';
import { audit } from './audit.js';
import { dispatchWaitingSoon } from './dispatch.js';

// One write per driver per this long; extra pings in between are dropped. A phone sending
// every second would otherwise be 3,600 writes an hour for a dot that moved 4 m.
export const MIN_INTERVAL_MS = 4000;
// A ride waiting for a driver gets another look when someone moves, at most this often.
const DISPATCH_NUDGE_MS = 10_000;

const lastWrite = new Map(); // driverId -> ms
let lastNudge = 0;

const clampInt = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : null;
};

// Returns true if stored, false if refused (bad fix, outside the area), null if throttled.
export async function recordDriverLocation({ driverId, raw, now = Date.now() }) {
  const fix = parseFix(raw);
  if (!fix || !inServiceArea(fix)) return false;
  const key = String(driverId);
  if (now - (lastWrite.get(key) || 0) < MIN_INTERVAL_MS) return null;
  lastWrite.set(key, now);

  const data = {
    lat: fix.lat,
    lng: fix.lng,
    accuracy_m: fix.accuracy,
    heading: clampInt(raw.heading, 0, 359),
    speed_kmh: clampInt(raw.speed, 0, 250),
    updated_at: new Date(now),
  };
  const id = BigInt(driverId);
  const [, jobs] = await Promise.all([
    prisma.driverLocation.upsert({ where: { driver_id: id }, create: { driver_id: id, ...data }, update: data }),
    prisma.order.findMany({
      where: { driver_id: id, status: { in: ['DISPATCHED', 'IN_TRANSIT'] } },
      select: { id: true },
    }),
  ]);

  // Who may see this dot is decided by the socket layer, per order, at delivery time.
  publish(TELEMETRY.DRIVER_LOCATION, {
    driverId: key,
    lat: data.lat,
    lng: data.lng,
    accuracy: data.accuracy_m,
    heading: data.heading,
    at: data.updated_at.toISOString(),
    orderIds: jobs.map((j) => j.id),
  });

  if (now - lastNudge > DISPATCH_NUDGE_MS) {
    lastNudge = now;
    dispatchWaitingSoon();
  }
  return true;
}

export async function setDriverOnline({ driverId, online }) {
  const driver = await prisma.driver.update({
    where: { id: BigInt(driverId) },
    data: { online },
    select: { id: true, name: true, vehicle: true, online: true },
  });
  await audit({ actor: `driver:${driverId}`, action: online ? 'driver.online' : 'driver.offline', subject: `driver:${driverId}` });
  return driver;
}

// Test hook: forget the throttle.
export function resetLocationThrottle() {
  lastWrite.clear();
  lastNudge = 0;
}
