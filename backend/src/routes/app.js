// The customer app's newer surfaces: the inbox (bell), ratings, nearby drivers on the home
// screen, trades, catalog pictures and suggestions, driver photos, the free-delivery banner,
// the customer's name, and manual wallet top-ups.
//
// Order-scoped routes here follow the same rule as routes/orders.js: requireOrderAccess, which
// is domain/access.js canAccessOrder (deny = 404).
import { Router, raw } from 'express';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireOrderAccess } from '../middleware/authorize.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { getObject } from '../storage/objectStore.js';
import { getInbox, markInboxSeen } from '../queries/inbox.js';
import { rateOrder, RatingError } from '../commands/ratings.js';
import { getRating, driverRatings } from '../queries/ratings.js';
import { getTrades } from '../queries/catalog.js';
import { publicSettings } from '../commands/settings.js';
import { dispatchCandidates } from '../commands/dispatch.js';
import { rideChoices, etaMinutes } from '../domain/dispatch.js';
import { parsePoint } from '../domain/geo.js';
import { VEHICLES } from '../domain/pricing.js';
import {
  createSubmission, attachSubmissionPhoto, mySubmissions, SubmissionError,
} from '../commands/submissions.js';
import { claimTopup, WalletError } from '../commands/wallet.js';
import { isInfraError } from '../middleware/errorHandler.js';
import { buildWalletUri } from '../domain/wallets.js';
import { config } from '../config.js';

export const appRouter = Router();
const customerOnly = requireRole('customer');
const rawImage = raw({ type: () => true, limit: '6mb' });

// Stream a stored picture. `immutable`: every key is random, so a new picture is a new URL.
async function streamObject(res, key, { cache = 'private, max-age=3600' } = {}) {
  try {
    const obj = await getObject(key);
    res.setHeader('Content-Type', obj.contentType || 'image/jpeg');
    res.setHeader('Cache-Control', cache);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    obj.body.pipe(res);
  } catch {
    res.status(404).json({ error: 'not found' });
  }
}

const known = (err, res, next, ...types) => {
  if (types.some((T) => err instanceof T)) return res.status(err.status).json({ error: err.message });
  return next(err);
};

// ── Public ──

// Farsamo: the trades and their visit fee.
appRouter.get('/trades', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  const trades = await getTrades();
  res.json({ trades: trades.map((t) => ({ slug: t.slug, name_en: t.name_en, name_so: t.name_so, icon: t.icon, visit_fee: String(t.visit_fee) })) });
});

// What the customer app shows as a banner (the free-delivery promo).
appRouter.get('/settings/public', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(await publicSettings());
});

// A catalog item's own picture (an approved upload). Public, like the catalog itself; only
// items that are live, and only a key the item row names.
appRouter.get('/catalog/items/:id/image', async (req, res) => {
  const item = await prisma.catalogItem.findFirst({ where: { id: Number(req.params.id) || 0, active: true }, select: { image: true } });
  if (!item?.image?.startsWith('obj/')) return res.status(404).json({ error: 'not found' });
  return streamObject(res, item.image.slice(4), { cache: 'public, max-age=86400, immutable' });
});

// ── Signed in ──

// A driver's photo, for the "choose your driver" list and the tracking card. Signed-in only,
// active drivers only. A face is personal data: not for anyone with a URL.
appRouter.get('/drivers/:id/photo', requireAuth, async (req, res) => {
  let id;
  try { id = BigInt(req.params.id); } catch { return res.status(404).json({ error: 'not found' }); }
  const d = await prisma.driver.findFirst({ where: { id, active: true }, select: { photo_key: true } });
  if (!d?.photo_key) return res.status(404).json({ error: 'not found' });
  return streamObject(res, d.photo_key);
});

// How close the nearest free drivers are, for the home banner. Counts and minutes, never
// positions (same rule as the ride quote).
appRouter.get(
  '/nearby',
  customerOnly,
  rateLimit({ windowMs: 60 * 1000, max: 30, message: 'too many requests' }),
  async (req, res) => {
    const p = parsePoint({ lat: req.query.lat, lng: req.query.lng });
    if (!p) return res.status(400).json({ error: 'set a position' });
    const pool = await dispatchCandidates(prisma);
    const out = {};
    for (const vehicle of VEHICLES) {
      const list = rideChoices(pool, { pickup: p, vehicle, limit: 20 });
      out[vehicle] = { count: list.length, eta_min: list.length ? etaMinutes(list[0].distance_m) : null };
    }
    res.json({ nearby: out });
  }
);

// GET /api/me — the account's display name (the greeting) — and set it.
appRouter.get('/me', customerOnly, async (req, res) => {
  const u = await prisma.user.findUnique({ where: { id: req.auth.uid }, select: { display_name: true } });
  res.json({ name: u?.display_name || null });
});
appRouter.post('/me/name', customerOnly, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ').slice(0, 40) : '';
  await prisma.user.update({ where: { id: req.auth.uid }, data: { display_name: name || null } });
  res.json({ name: name || null });
});

// The inbox (bell). Derived; only "read up to" is stored.
appRouter.get('/inbox', customerOnly, async (req, res) => {
  res.json(await getInbox(req.auth.uid));
});
appRouter.post('/inbox/seen', customerOnly, async (req, res) => {
  await markInboxSeen(req.auth.uid);
  res.json({ ok: true });
});

// The driver on this order, as the customer sees them: first name, vehicle, plate, photo,
// rating. Only while it is theirs (dispatched, on the way, or just finished). The phone (the
// call button, owner's call 2026-11-12) only while the job is LIVE — not during the offer,
// not after it is done, and never in the list of drivers to choose from.
appRouter.get('/orders/:id/driver', customerOnly, requireOrderAccess, async (req, res) => {
  const o = req.order;
  const shown = ['DISPATCHED', 'IN_TRANSIT', 'DELIVERED'].includes(o.status);
  const id = shown ? o.driver_id : o.offer_driver_id;
  if (id == null) return res.json({ driver: null });
  const d = await prisma.driver.findUnique({ where: { id }, select: { id: true, name: true, vehicle: true, plate: true, photo_key: true, role: true, msisdn: true } });
  if (!d) return res.json({ driver: null });
  const live = ['DISPATCHED', 'IN_TRANSIT'].includes(o.status);
  const r = (await driverRatings([d.id])).get(String(d.id));
  res.json({
    driver: {
      id: String(d.id), name: d.name.trim().split(/\s+/)[0], vehicle: d.vehicle, plate: d.plate, role: d.role,
      phone: live ? d.msisdn : null,
      photo: Boolean(d.photo_key), rating: r?.avg ?? null, ratings: r?.count ?? 0,
      offer: !shown, offer_expires_at: !shown ? o.offer_expires_at : null,
    },
  });
});

// Rate a finished job, and read the rating back.
appRouter.get('/orders/:id/rating', customerOnly, requireOrderAccess, async (req, res) => {
  res.json({ rating: await getRating(req.params.id) });
});
appRouter.post(
  '/orders/:id/rating',
  customerOnly,
  requireOrderAccess,
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'too many requests' }),
  async (req, res, next) => {
    try {
      const r = await rateOrder({ orderId: req.params.id, userId: req.auth.uid, stars: req.body?.stars, comment: req.body?.comment });
      res.status(201).json({ rating: { stars: r.stars, comment: r.comment } });
    } catch (err) {
      known(err, res, next, RatingError);
    }
  }
);

// Extra-work quotes under a visit (Farsamo): each is its own prepaid order.
appRouter.get('/orders/:id/extras', customerOnly, requireOrderAccess, async (req, res) => {
  const extras = await prisma.order.findMany({
    where: { parent_order_id: req.params.id, user_id: req.auth.uid },
    orderBy: { created_at: 'asc' },
    select: { id: true, status: true, total_amount: true, details: true, created_at: true },
  });
  res.json({ extras });
});

// ── Catalog suggestions (commands/submissions.js) ──
appRouter.post(
  '/catalog/submissions',
  customerOnly,
  rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 10, key: (req) => `sub:${req.auth.uid}`, message: 'too many suggestions today' }),
  async (req, res, next) => {
    try {
      const sub = await createSubmission({ userId: req.auth.uid, name: req.body?.name, note: req.body?.note, service: req.body?.service });
      res.status(201).json({ submission: sub });
    } catch (err) {
      known(err, res, next, SubmissionError);
    }
  }
);
appRouter.post(
  '/catalog/submissions/:id/photo',
  customerOnly,
  rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: 'too many uploads' }),
  rawImage,
  async (req, res, next) => {
    try {
      res.status(201).json(await attachSubmissionPhoto({ id: req.params.id, userId: req.auth.uid, bytes: req.body }));
    } catch (err) {
      if (isInfraError(err)) return next(err);
      known(err, res, next, SubmissionError);
    }
  }
);
appRouter.get('/catalog/submissions/mine', customerOnly, async (req, res) => {
  res.json({ submissions: await mySubmissions(req.auth.uid) });
});

// The dial links for topping up `amount` (the same %23-encoded USSD the order screen uses).
appRouter.get('/wallet/topup-options', customerOnly, (req, res) => {
  const amount = Number(req.query.amount);
  if (!config.wallet.enabled) return res.status(404).json({ error: 'the wallet is not available' });
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000) return res.status(400).json({ error: 'top up between $1.00 and $200.00' });
  const ussd = config.paymentConfirmation === 'operator'
    ? config.payment.wallets.map((w) => ({ id: w.id, name: w.name, ussdUri: buildWalletUri(w, amount.toFixed(2)) }))
    : [];
  res.json({ ussd });
});

// ── Wallet: a USSD top-up the customer claims; an operator confirms it (commands/wallet.js) ──
appRouter.post(
  '/wallet/topup-claim',
  customerOnly,
  rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'too many requests' }),
  async (req, res, next) => {
    try {
      const a = await claimTopup({ userId: req.auth.uid, amount: req.body?.amount, wallet: req.body?.wallet, reference: req.body?.reference });
      res.status(201).json({ attempt: { id: a.id, status: a.status, amount: String(a.amount) } });
    } catch (err) {
      known(err, res, next, WalletError);
    }
  }
);
