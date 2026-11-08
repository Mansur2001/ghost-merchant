// Road distance between two points: a self-hosted OSRM when ROUTING_URL is set, otherwise the
// straight line times a detour factor (domain/geo.js). OSRM is optional on purpose — one small
// VPS must be able to run everything, and a fare quote must never fail because a routing
// container is down. A slow or broken OSRM costs accuracy, never availability.
import { config } from '../config.js';
import { estimateRoadMeters, etaMinutes } from '../domain/geo.js';

const TIMEOUT_MS = 1500;

export async function routeBetween(a, b, { url = config.routingUrl, fetchImpl = fetch } = {}) {
  const estimate = () => {
    const meters = estimateRoadMeters(a, b);
    return { meters, minutes: etaMinutes(meters), source: 'estimate' };
  };
  if (!url) return estimate();

  try {
    // OSRM wants lng,lat. overview=false: we need the numbers, not the geometry.
    const path = `${a.lng},${a.lat};${b.lng},${b.lat}`;
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/route/v1/driving/${path}?overview=false`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return estimate();
    const body = await res.json();
    const r = body?.routes?.[0];
    const meters = Math.round(Number(r?.distance));
    const seconds = Number(r?.duration);
    // A route shorter than the straight line is a snapping artefact; one more than 3x is a
    // detour round a missing road. Either way the estimate is the better number.
    const straight = estimateRoadMeters(a, b) / 1.3;
    if (body?.code !== 'Ok' || !Number.isFinite(meters) || meters < straight * 0.9 || meters > straight * 3 + 500) {
      return estimate();
    }
    // OSRM's car speeds are for empty roads; take the slower of it and our city speed.
    const minutes = Math.max(Math.ceil(seconds / 60), etaMinutes(meters));
    return { meters, minutes, source: 'osrm' };
  } catch {
    return estimate();
  }
}

// The full route for navigation: the road geometry and each maneuver. Null when no routing
// engine is configured or it can't answer — the apps then draw a straight line and offer the
// phone's own maps app. Never invents a route.
export async function routeDetail(a, b, { url = config.routingUrl, fetchImpl = fetch } = {}) {
  if (!url) return null;
  try {
    const path = `${a.lng},${a.lat};${b.lng},${b.lat}`;
    const res = await fetchImpl(
      `${url.replace(/\/$/, '')}/route/v1/driving/${path}?overview=full&geometries=geojson&steps=true`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) return null;
    const body = await res.json();
    const r = body?.routes?.[0];
    if (body?.code !== 'Ok' || !r) return null;
    const meters = Math.round(r.distance);
    return {
      meters,
      // OSRM's speeds are for empty roads; never promise faster than our city speed.
      minutes: Math.max(Math.ceil(r.duration / 60), etaMinutes(meters)),
      // [lat, lng] pairs, rounded to ~1 m: what Leaflet draws and the apps snap to.
      geometry: (r.geometry?.coordinates || []).map(([lng, lat]) => [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]),
      steps: (r.legs?.[0]?.steps || []).map((s) => ({
        type: s.maneuver?.type,
        modifier: s.maneuver?.modifier || null,
        exit: s.maneuver?.exit ?? null,
        name: s.name || '',
        distance: Math.round(s.distance),
        duration: Math.round(s.duration),
        at: s.maneuver?.location ? [s.maneuver.location[1], s.maneuver.location[0]] : null,
      })),
    };
  } catch {
    return null;
  }
}
