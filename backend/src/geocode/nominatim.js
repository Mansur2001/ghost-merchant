// Search any place in Somalia through OpenStreetMap's Nominatim, on behalf of the apps.
//
// The public server's rules (operations.osmfoundation.org/policies/nominatim) are kept here:
//   * at most ONE request per second, from this whole backend (a queue, not a hope);
//   * an identifying User-Agent with a contact address;
//   * results cached, so the same search isn't asked twice;
//   * no search-as-you-type: the apps search when the person presses Search.
// Heavy use needs our own Nominatim — set NOMINATIM_URL to it and nothing else changes.
// Only the search text leaves the server: never who asked.
import { config } from '../config.js';
import { inServiceArea, SERVICE_AREA, distanceMeters } from '../domain/geo.js';

const CACHE_MAX = 500;
const CACHE_MS = 24 * 3600 * 1000;
const cache = new Map(); // folded query + lang -> { at, results }
let chain = Promise.resolve();
let lastAt = 0;

// Run `fn` no sooner than 1.1 s after the previous request, one at a time.
function throttled(fn) {
  const run = chain.then(async () => {
    const wait = lastAt + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

export const foldQuery = (q) => String(q || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);

// How far around the person's map a search looks first (~28 km: all of Mogadishu).
const NEAR_DEG = 0.25;

// `near` = the point the person is looking at (the map's centre). Without it, "Bakaara" found a
// hamlet in Gedo before the market in Mogadishu, and "hospital" found nothing at all (a kind
// of place is only searchable inside a box). So: that area first, the whole country only if
// it has nothing, each with how far it is.
export async function geocode(q, { lang = 'en', near = null, settings = config.geocoder, fetchImpl = fetch } = {}) {
  const query = foldQuery(q);
  if (query.length < 3 || !settings.url) return [];
  // The area to 0.1° (~11 km): close enough to share a cache entry, far enough to be no trail.
  const around = near && inServiceArea(near)
    ? { lat: Math.round(near.lat * 10) / 10, lng: Math.round(near.lng * 10) / 10 } : null;
  const key = `${lang}|${around ? `${around.lat},${around.lng}` : '-'}|${query}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;

  let results = [];
  if (around) {
    results = await search(query, lang, {
      minLat: around.lat - NEAR_DEG, maxLat: around.lat + NEAR_DEG,
      minLng: around.lng - NEAR_DEG, maxLng: around.lng + NEAR_DEG,
    }, settings, fetchImpl);
  }
  if (!results.length) results = await search(query, lang, SERVICE_AREA, settings, fetchImpl);
  // Nominatim's order is by how well the name matches; kept (nearest-first put "ex dugsi sare
  // banadir" above Banadir Hospital). The box already made them local; the distance is shown.
  if (near) results = results.map((r) => ({ ...r, distance_m: Math.round(distanceMeters(near, r)) }));
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), results });
  return results;
}

async function search(query, lang, { minLat, maxLat, minLng, maxLng }, settings, fetchImpl) {
  const params = new URLSearchParams({
    q: query, format: 'jsonv2', countrycodes: 'so', limit: '8', addressdetails: '0',
    'accept-language': lang === 'so' ? 'so,en' : 'en,so',
    viewbox: `${minLng},${maxLat},${maxLng},${minLat}`, bounded: '1',
  });
  return throttled(async () => {
    const res = await fetchImpl(`${settings.url.replace(/\/$/, '')}/search?${params}`, {
      headers: { 'User-Agent': settings.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`geocoder answered ${res.status}`);
    const body = await res.json();
    return (Array.isArray(body) ? body : [])
      .map((r) => ({
        name: String(r.name || r.display_name || '').slice(0, 80),
        detail: String(r.display_name || '').split(',').slice(1, 4).join(',').trim().slice(0, 120),
        lat: Math.round(Number(r.lat) * 1e6) / 1e6,
        lng: Math.round(Number(r.lon) * 1e6) / 1e6,
        // OSM's own words (amenity/hospital, shop/clothes…): the apps draw the same icon as the map.
        kind: r.type || null,
        category: r.category || null,
      }))
      .filter((r) => r.name && inServiceArea(r));
  });
}

export function resetGeocoder() {
  cache.clear();
  lastAt = 0;
  chain = Promise.resolve();
}
