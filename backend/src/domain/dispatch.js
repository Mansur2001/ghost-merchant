// Who gets the next paid job. Pure, so the rule is testable and nobody can argue with it.
//
// No human picks a driver. Two rules, by job kind:
//
//   DELIVERY  the online driver (PIN set) with the fewest active deliveries; ties go to whoever
//             has waited longest since their last assignment, then the oldest account. Fair
//             rotation: no favourites, no one starved. MAX_ACTIVE deliveries at most, and never
//             a driver who is carrying a rider. PARCEL jobs count and go the same way.
//   RIDE      the NEAREST free online driver in the right vehicle, with a recent fix, within
//             RIDE_RADIUS_M of the pickup. A rider waits on a corner; fairness here is a short
//             wait, and a driver across town is not a fair offer to anyone. Ties (same distance
//             band) still go to whoever has waited longest. The customer may CHOOSE a driver
//             from the nearby list: that driver is offered the job first (domain/offers.js),
//             and this rule runs only if they decline or don't answer.
//   SERVICE   a TECHNICIAN with that trade, online, with no visit under way: nearest first
//             when positions are known (300 m bands), then longest wait.
//
// Drivers never get SERVICE jobs and technicians never get anything else (`role`). Anyone
// with a live offer waiting is skipped: they might be about to accept it.
import { distanceMeters } from './proof.js';

export const MAX_ACTIVE_PER_DRIVER = 3;
export const RIDE_RADIUS_M = 8000;
// A position older than this doesn't say where the driver is now.
export const LOCATION_FRESH_MS = 3 * 60 * 1000;
// Distances inside one band count as equal, so 40 m of GPS noise doesn't override fairness.
const DISTANCE_BAND_M = 300;

const isDriver = (d) => (d.role ?? 'driver') === 'driver';
const free = (d) => !d.has_offer;
const waited = (d) => (d.last_assigned_at ? new Date(d.last_assigned_at).getTime() : 0);
const byId = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);

// candidates: [{ id, active, ready, online, active_orders, active_rides, last_assigned_at }]
export function pickDriver(candidates, maxActive = MAX_ACTIVE_PER_DRIVER) {
  const eligible = candidates.filter((d) => d.active && d.ready && d.online && isDriver(d) && free(d)
    && !(d.active_rides > 0) && !(d.active_services > 0) && d.active_orders < maxActive);
  if (!eligible.length) return null;
  eligible.sort((a, b) => a.active_orders - b.active_orders || waited(a) - waited(b) || byId(a, b));
  return eligible[0];
}

// candidates as above plus { vehicle, lat, lng, located_at }. pickup: { lat, lng }.
export function pickRideDriver(candidates, { pickup, vehicle, now = Date.now(), radius = RIDE_RADIUS_M }) {
  const eligible = [];
  for (const d of candidates) {
    if (!d.active || !d.ready || !d.online || d.vehicle !== vehicle || !isDriver(d) || !free(d)) continue;
    // A rider gets the whole vehicle: nobody already on a job.
    if (d.active_orders > 0 || d.active_rides > 0 || d.active_services > 0) continue;
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

// candidates as above plus { role, trades }. site: { lat, lng } (where the visit is).
export function pickTechnician(candidates, { trade, site, now = Date.now() }) {
  const eligible = [];
  for (const d of candidates) {
    if (!d.active || !d.ready || !d.online || d.role !== 'technician' || !free(d)) continue;
    if (!(d.trades || []).includes(trade)) continue;
    // One visit at a time: a technician is in someone's house.
    if (d.active_services > 0 || d.active_orders > 0 || d.active_rides > 0) continue;
    const fresh = d.lat != null && d.located_at && now - new Date(d.located_at).getTime() <= LOCATION_FRESH_MS;
    const distance = fresh && site?.lat != null ? distanceMeters(site, d) : null;
    eligible.push({ ...d, distance_m: distance });
  }
  if (!eligible.length) return null;
  // Unknown distance sorts after every known one, but still gets work.
  const band = (d) => (d.distance_m == null ? Number.MAX_SAFE_INTEGER : Math.floor(d.distance_m / DISTANCE_BAND_M));
  eligible.sort((a, b) => band(a) - band(b) || waited(a) - waited(b) || byId(a, b));
  return eligible[0];
}

// The drivers a customer may choose from for a ride: the same rule as pickRideDriver, every
// match instead of the first, nearest first. `limit` keeps the list a choice, not a census.
export function rideChoices(candidates, { pickup, vehicle, now = Date.now(), limit = 5 }) {
  const pool = [...candidates];
  const out = [];
  while (out.length < limit) {
    const d = pickRideDriver(pool, { pickup, vehicle, now });
    if (!d) break;
    out.push(d);
    pool.splice(pool.findIndex((c) => String(c.id) === String(d.id)), 1);
  }
  return out.sort((a, b) => a.distance_m - b.distance_m);
}

// Minutes for a driver to reach a pickup `meters` away (straight line). City roads wind:
// ×1.4, at the 18 km/h floor the routing uses. Never under a minute — nobody is "0 min" away.
export function etaMinutes(meters) {
  if (meters == null) return null;
  return Math.max(1, Math.round(((meters * 1.4) / 1000 / 18) * 60));
}
