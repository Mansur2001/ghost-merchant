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
import { inServiceArea, SERVICE_AREA } from '../domain/geo.js';

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

export async function geocode(q, { lang = 'en', settings = config.geocoder, fetchImpl = fetch } = {}) {
  const query = foldQuery(q);
  if (query.length < 3 || !settings.url) return [];
  const key = `${lang}|${query}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;

  const { minLat, maxLat, minLng, maxLng } = SERVICE_AREA;
  const params = new URLSearchParams({
    q: query, format: 'jsonv2', countrycodes: 'so', limit: '8', addressdetails: '0',
    'accept-language': lang === 'so' ? 'so,en' : 'en,so',
    viewbox: `${minLng},${maxLat},${maxLng},${minLat}`, bounded: '1',
  });
  const results = await throttled(async () => {
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
        kind: r.type || r.category || null,
      }))
      .filter((r) => r.name && inServiceArea(r));
  });
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), results });
  return results;
}

export function resetGeocoder() {
  cache.clear();
  lastAt = 0;
  chain = Promise.resolve();
}
