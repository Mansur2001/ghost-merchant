// Points on the map: parsing them at the trust boundary, and how far apart two of them are.
// Pure, so pricing, dispatch and proofs all measure the same way.
import { distanceMeters } from './proof.js';

export { distanceMeters };

// Where we operate: Somalia and Somaliland, with a margin. A point outside is a bad GPS fix,
// a pin dropped by mistake, or a client making up coordinates — never a real job, and never
// something to price (a "ride" across the continent is a fare nobody can pay or refund).
export const SERVICE_AREA = { minLat: -1.9, maxLat: 12.3, minLng: 40.8, maxLng: 51.6 };

export function inServiceArea({ lat, lng }, area = SERVICE_AREA) {
  return lat >= area.minLat && lat <= area.maxLat && lng >= area.minLng && lng <= area.maxLng;
}

// A {lat, lng} from client input, or null. Strict, unlike a proof's fix: this point decides a
// price and where a driver goes, so a bad one is refused rather than dropped.
export function parsePoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  // 6 decimals is ~10 cm. More is noise, and it keeps stored rows small.
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

// Roads are longer than the straight line. 1.3 is the usual city detour factor; it is the
// estimate used when no routing engine is configured (domain/routing.js).
export const ROAD_FACTOR = 1.3;

export function estimateRoadMeters(a, b) {
  return Math.round(distanceMeters(a, b) * ROAD_FACTOR);
}

// Minutes to cover `meters` in Somali city traffic. Deliberately pessimistic: an ETA that is
// early is a disappointed customer, one that is late is a pleasant surprise.
export const CITY_SPEED_KMH = 18;

export function etaMinutes(meters, speedKmh = CITY_SPEED_KMH) {
  if (!Number.isFinite(meters) || meters <= 0) return 1;
  return Math.max(1, Math.ceil((meters / 1000 / speedKmh) * 60));
}

// The place in `places` nearest to `point`, or null. Small lists only (the fixed places
// table), so a linear scan is the right tool.
export function nearestPlace(point, places) {
  let best = null;
  let bestD = Infinity;
  for (const p of places) {
    const d = distanceMeters(point, p);
    if (d < bestD) { best = p; bestD = d; }
  }
  return best ? { place: best, distance_m: bestD } : null;
}
