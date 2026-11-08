// Who gets the next paid job. Pure, so the rule is testable and nobody can argue with it.
//
// No human picks a driver. Two rules, by job kind:
//
//   DELIVERY  the online driver (PIN set) with the fewest active deliveries; ties go to whoever
//             has waited longest since their last assignment, then the oldest account. Fair
//             rotation: no favourites, no one starved. MAX_ACTIVE deliveries at most, and never
//             a driver who is carrying a rider.
//   RIDE      the NEAREST free online driver in the right vehicle, with a recent fix, within
//             RIDE_RADIUS_M of the pickup. A rider waits on a corner; fairness here is a short
//             wait, and a driver across town is not a fair offer to anyone. Ties (same distance
//             band) still go to whoever has waited longest.
import { distanceMeters } from './proof.js';

export const MAX_ACTIVE_PER_DRIVER = 3;
export const RIDE_RADIUS_M = 8000;
// A position older than this doesn't say where the driver is now.
export const LOCATION_FRESH_MS = 3 * 60 * 1000;
// Distances inside one band count as equal, so 40 m of GPS noise doesn't override fairness.
const DISTANCE_BAND_M = 300;

const waited = (d) => (d.last_assigned_at ? new Date(d.last_assigned_at).getTime() : 0);
const byId = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);

// candidates: [{ id, active, ready, online, active_orders, active_rides, last_assigned_at }]
export function pickDriver(candidates, maxActive = MAX_ACTIVE_PER_DRIVER) {
  const eligible = candidates.filter((d) => d.active && d.ready && d.online
    && !(d.active_rides > 0) && d.active_orders < maxActive);
  if (!eligible.length) return null;
  eligible.sort((a, b) => a.active_orders - b.active_orders || waited(a) - waited(b) || byId(a, b));
  return eligible[0];
}

// candidates as above plus { vehicle, lat, lng, located_at }. pickup: { lat, lng }.
export function pickRideDriver(candidates, { pickup, vehicle, now = Date.now(), radius = RIDE_RADIUS_M }) {
  const eligible = [];
  for (const d of candidates) {
    if (!d.active || !d.ready || !d.online || d.vehicle !== vehicle) continue;
    // A rider gets the whole vehicle: nobody already on a job.
    if (d.active_orders > 0 || d.active_rides > 0) continue;
    if (d.lat == null || d.lng == null || !d.located_at) continue;
    if (now - new Date(d.located_at).getTime() > LOCATION_FRESH_MS) continue;
    const distance = distanceMeters(pickup, d);
    if (distance > radius) continue;
    eligible.push({ ...d, distance_m: distance });
  }
  if (!eligible.length) return null;
  const band = (d) => Math.floor(d.distance_m / DISTANCE_BAND_M);
  eligible.sort((a, b) => band(a) - band(b) || waited(a) - waited(b) || byId(a, b));
  return eligible[0];
}
