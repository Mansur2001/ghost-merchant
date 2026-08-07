// User-facing order + chat routes.
//
// AUTHORIZATION MODEL (read before adding a route here):
//   Every route that names an order takes `requireAuth, requireOrderAccess`. That pair is the
//   only thing standing between a stranger and a customer's phone number, home landmark,
//   chat, and photos. A new route without it is a data breach, not a missing feature.
//   The ownership rule itself lives in domain/access.js — don't re-implement it inline.
import { Router, raw } from 'express';
import { createOrder, postMessage } from '../commands/orders.js';
import { getOrderTimeline, getMessages, getOrdersByPhone } from '../queries/orders.js';
import { savePhoto } from '../commands/photos.js';
import { listPhotos, getPhoto } from '../queries/photos.js';
import { getObject } from '../storage/objectStore.js';
import { buildUssdUri } from '../domain/ussd.js';
import { parseSomaliMsisdn } from '../domain/phone.js';
import { senderForRole } from '../domain/access.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireOrderAccess } from '../middleware/authorize.js';
import { rateLimit } from '../middleware/rateLimit.js';

export const ordersRouter = Router();

// Raw image body parser, scoped to photo-upload routes only (the global express.json skips
// non-JSON bodies, so image bytes pass through untouched to this). 6MB ceiling — photos are
// separate from the sub-10KB order payload budget.
const rawImage = raw({ type: () => true, limit: '6mb' });

const customerOnly = requireRole('customer');

// Live Somali-number validation for the frontend (also the single source of truth). Public by
// necessity — it runs BEFORE anyone can have a session. It's a pure function over the input
// and touches no data, so the only abuse is volume; rate-limit and move on.
ordersRouter.get(
  '/phone/validate/:phone',
  rateLimit({ windowMs: 60 * 1000, max: 120 }),
  (req, res) => {
    res.json(parseSomaliMsisdn(req.params.phone));
  }
);

// GET /api/orders/mine — the authenticated customer's own orders (resume view).
// Replaces the old /orders/by-phone/:phone, which let anyone list any number's orders by
// typing it. The phone now comes from the verified token and can't be chosen by the caller.
ordersRouter.get('/orders/mine', customerOnly, async (req, res) => {
  const orders = await getOrdersByPhone(req.auth.phone);
  res.json({
    phone: req.auth.phone,
    orders: orders.map((o) => ({ ...o, ussdUri: buildUssdUri(o.total_amount) })),
  });
});

// Create an order from the PWA checkout. Payload MUST stay sub-10KB.
// The owning phone is taken from the session, NOT the body — otherwise a verified customer
// could create orders (and chat threads) under someone else's number.
ordersRouter.post('/orders', customerOnly, async (req, res) => {
  try {
    const { items, totalAmount, lat, lng, landmark } = req.body || {};
    const order = await createOrder({
      userPhone: req.auth.phone,
      items,
      totalAmount,
      lat,
      lng,
      landmark,
    });
    res.status(201).json({ order, ussdUri: buildUssdUri(order.total_amount) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

ordersRouter.get('/orders/:id', requireAuth, requireOrderAccess, (req, res) => {
  res.json({ order: req.order, ussdUri: buildUssdUri(req.order.total_amount) });
});

ordersRouter.get('/orders/:id/timeline', requireAuth, requireOrderAccess, async (req, res) => {
  res.json({ timeline: await getOrderTimeline(req.params.id) });
});

ordersRouter.get('/orders/:id/messages', requireAuth, requireOrderAccess, async (req, res) => {
  res.json({ messages: await getMessages(req.params.id) });
});

// ── Photos (MinIO-backed) ──
// Customer attaches a reference photo to their own order.
ordersRouter.post(
  '/orders/:id/photos/order_ref',
  customerOnly,
  requireOrderAccess,
  rawImage,
  async (req, res) => {
    try {
      const photo = await savePhoto({
        orderId: req.params.id,
        kind: 'order_ref',
        bytes: req.body,
        contentType: req.get('Content-Type'),
        uploadedBy: 'user',
      });
      res.status(201).json({ photo });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// List an order's photos. `url` is a backend-mediated stream (browser never touches MinIO).
ordersRouter.get('/orders/:id/photos', requireAuth, requireOrderAccess, async (req, res) => {
  const photos = await listPhotos(req.params.id);
  res.json({
    photos: photos.map((p) => ({
      id: p.id, kind: p.kind, uploaded_by: p.uploaded_by, created_at: p.created_at,
      url: `/api/orders/${req.params.id}/photos/${p.id}/raw`,
    })),
  });
});

// Stream the actual bytes from MinIO through the backend (keeps storage creds off the client).
// Authorized like every other order-scoped read — these are photos of people's homes and goods.
ordersRouter.get(
  '/orders/:id/photos/:photoId/raw',
  requireAuth,
  requireOrderAccess,
  async (req, res) => {
    try {
      const meta = await getPhoto(req.params.photoId);
      if (!meta || String(meta.order_id) !== String(req.params.id)) {
        return res.status(404).json({ error: 'not found' });
      }
      const { body, contentType } = await getObject(meta.object_key);
      res.setHeader('Content-Type', contentType || meta.content_type || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, no-store');
      body.on('error', () => res.destroy());
      body.pipe(res);
    } catch {
      res.status(404).json({ error: 'not found' });
    }
  }
);

// Post a chat message into the order thread. The `sender` is derived from the authenticated
// role — a client can no longer label its own message 'system' or 'operator'.
ordersRouter.post('/orders/:id/messages', requireAuth, requireOrderAccess, async (req, res) => {
  try {
    const { body } = req.body || {};
    if (!body) return res.status(400).json({ error: 'body required' });
    const sender = senderForRole(req.auth.role);
    if (!sender) return res.status(403).json({ error: 'forbidden' });
    const message = await postMessage({ orderId: req.params.id, sender, body });
    res.status(201).json({ message });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
