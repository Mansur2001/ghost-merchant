// Navigation and place search for the three apps. Signed-in callers only, and rate-limited:
// both proxy a service (our OSRM, OpenStreetMap's Nominatim) that must not be hammered.
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { routeDetail } from '../routing/route.js';
import { geocode } from '../geocode/nominatim.js';
import { parsePoint, inServiceArea } from '../domain/geo.js';

export const mapsRouter = Router();

const who = (req) => `${req.auth?.role}:${req.auth?.uid ?? req.auth?.id}`;
const pointOf = (raw) => {
  const [lat, lng] = String(raw || '').split(',');
  const p = parsePoint({ lat, lng });
  return p && inServiceArea(p) ? p : null;
};

// GET /api/route?from=lat,lng&to=lat,lng — road route with turn-by-turn steps.
// { route: null } when no routing engine is set up: the apps fall back to a straight line.
mapsRouter.get(
  '/route',
  requireAuth,
  rateLimit({ windowMs: 60 * 1000, max: 30, key: who, message: 'too many route requests' }),
  async (req, res) => {
    const from = pointOf(req.query.from);
    const to = pointOf(req.query.to);
    if (!from || !to) return res.status(400).json({ error: 'from and to must be points in Somalia' });
    res.json({ route: await routeDetail(from, to) });
  }
);

// GET /api/geocode?q=…&lang=en|so — any place in Somalia from OpenStreetMap.
mapsRouter.get(
  '/geocode',
  requireAuth,
  rateLimit({ windowMs: 60 * 1000, max: 15, key: who, message: 'too many searches — wait a moment' }),
  async (req, res) => {
    try {
      const results = await geocode(req.query.q, { lang: req.query.lang === 'so' ? 'so' : 'en' });
      res.json({ results, attribution: '© OpenStreetMap contributors' });
    } catch (err) {
      console.warn(`[geocode] ${err.message}`);
      res.status(503).json({ error: 'place search is unavailable right now' });
    }
  }
);
