// The proof-of-delivery standard. Pure rules — no DB, no Express — so they can be tested
// exhaustively and the driver app, the operator review queue and the commands all agree.
//
//   pickup   (DISPATCHED -> IN_TRANSIT)  a photo of the goods. Always. (A ride: the rider's code.)
//   delivery (IN_TRANSIT -> DELIVERED)   the customer's 4-digit handoff code, OR — when the
//                                        customer can't give it — a door photo plus a reason,
//                                        which is flagged for an operator to check.
//
// Every step also carries the driver's GPS fix when the phone gives one. It is evidence, not
// a gate: refusing a delivery because a cheap handset had no fix would strand a driver who
// did the job. A missing or far-off fix is flagged instead.
import { randomInt, timingSafeEqual } from 'node:crypto';

export const HANDOFF_MAX_ATTEMPTS = 5;
// Further than this from the customer's pin and the delivery gets a second look. Generous on
// purpose: phone GPS in a dense city is often 50–150 m off, and pins are set by hand.
export const PROOF_RADIUS_M = 300;
export const REASON_MAX = 200;
// How long after delivery the customer can say "I didn't get it".
export const DISPUTE_WINDOW_HOURS = 72;

// Uniform over 0000–9999. randomInt is the CSPRNG; Math.random would be guessable.
export function newHandoffCode() {
  return String(randomInt(0, 10000)).padStart(4, '0');
}

export function isHandoffCode(code) {
  return typeof code === 'string' && /^\d{4}$/.test(code);
}

// Constant-time, so response timing can't leak how many leading digits were right.
export function handoffMatches(expected, given) {
  if (!isHandoffCode(expected) || !isHandoffCode(given)) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

// A GPS fix from the client, or null. Anything malformed is dropped rather than refused: the
// fix is supporting evidence, and a bad one is the same as none (and flagged the same way).
export function parseFix(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const acc = Number(raw.accuracy);
  return {
    lat,
    lng,
    accuracy: Number.isFinite(acc) && acc >= 0 ? Math.min(Math.round(acc), 100000) : null,
  };
}

// Great-circle distance in metres (haversine). Good to well under a metre at city scale.
export function distanceMeters(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// The trimmed reason a driver gave, or null when there isn't a usable one.
export function cleanReason(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().slice(0, REASON_MAX);
  return s.length >= 3 ? s : null;
}

// What to store for one step: where the driver was, how far from the pin, and why (if at all)
// an operator should look. `order` needs lat/lng (the end pin) and, for rides, pickup_lat/lng.
//
// Rides prove different things (CLAUDE.md, Proof of delivery):
//   pickup   the rider's 4-digit code — the right person got in. Without it, a reason, flagged.
//   delivery a drop-off fix, compared with the destination. No code: the rider is in the car.
export function buildProof({ step, method, fix, order, note = null }) {
  const isRide = order?.kind === 'RIDE';
  const pinOf = (lat, lng) => (lat != null && lng != null ? { lat, lng } : null);
  const pin = isRide && step === 'pickup'
    ? pinOf(order.pickup_lat, order.pickup_lng)
    : pinOf(order?.lat, order?.lng);
  const distance = fix && pin ? distanceMeters(fix, pin) : null;

  const flags = [];
  const checked = step === 'delivery' || (isRide && step === 'pickup');
  if (checked) {
    if (method === 'photo_no_code' || method === 'no_code') flags.push('no_code');
    if (!fix) flags.push('no_gps');
    else if (distance != null && distance > PROOF_RADIUS_M) flags.push('far_from_pin');
  }
  // A rider dropped off early (they asked to stop) is normal; a pickup code that matched
  // proves the pickup. Neither needs a person to look, unless the code was skipped.
  if (isRide && step === 'pickup' && method === 'code') flags.length = 0;

  return {
    step,
    method,
    note,
    lat: fix?.lat ?? null,
    lng: fix?.lng ?? null,
    accuracy_m: fix?.accuracy ?? null,
    distance_m: distance,
    flags,
  };
}
