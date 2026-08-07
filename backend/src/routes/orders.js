// User-facing order + chat routes.
import { Router, raw } from 'express';
import { createOrder, postMessage } from '../commands/orders.js';
import { getOrder, getOrderTimeline, getMessages, getOrdersByPhone } from '../queries/orders.js';
import { savePhoto } from '../commands/photos.js';
import { listPhotos, getPhoto } from '../queries/photos.js';
import { getObject } from '../storage/objectStore.js';
import { buildUssdUri } from '../domain/ussd.js';
import { parseSomaliMsisdn } from '../domain/phone.js';

export const ordersRouter = Router();

// Raw image body parser, scoped to photo-upload routes only (the global express.json skips
// non-JSON bodies, so image bytes pass through untouched to this). 6MB ceiling — photos are
// separate from the sub-10KB order payload budget.
const rawImage = raw({ type: () => true, limit: '6mb' });

// Live phone validation for the frontend (also the single source of truth). The user PWA
// hits this to confirm a number before creating an order / resuming.
ordersRouter.get('/phone/validate/:phone', (req, res) => {
  const r = parseSomaliMsisdn(req.params.phone);
  res.json(r);
});

// Resume: fetch a customer's orders by phone number (canonicalized). Powers the
// "resume order" view so a refresh or a returning user recovers their live order.
ordersRouter.get('/orders/by-phone/:phone', async (req, res) => {
  const parsed = parseSomaliMsisdn(req.params.phone);
  if (!parsed.valid) return res.status(400).json({ error: parsed.reason, valid: false });
  const orders = await getOrdersByPhone(parsed.e164);
  res.json({
    phone: parsed.e164,
    operator: parsed.operator,
    orders: orders.map((o) => ({ ...o, ussdUri: buildUssdUri(o.total_amount) })),
  });
});

// Create an order from the PWA checkout. Payload MUST stay sub-10KB.
ordersRouter.post('/orders', async (req, res) => {
  try {
    const { userPhone, items, totalAmount, lat, lng, landmark } = req.body || {};
    const order = await createOrder({ userPhone, items, totalAmount, lat, lng, landmark });
    res.status(201).json({
      order,
      ussdUri: buildUssdUri(order.total_amount),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

ordersRouter.get('/orders/:id', async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'not found' });
  res.json({ order, ussdUri: buildUssdUri(order.total_amount) });
});

ordersRouter.get('/orders/:id/timeline', async (req, res) => {
  res.json({ timeline: await getOrderTimeline(req.params.id) });
});

ordersRouter.get('/orders/:id/messages', async (req, res) => {
  res.json({ messages: await getMessages(req.params.id) });
});

// ── Photos (MinIO-backed) ──
// Customer attaches a reference photo to their order (trust-on-phone, same as order create).
ordersRouter.post('/orders/:id/photos/order_ref', rawImage, async (req, res) => {
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
});

// List an order's photos. `url` is a backend-mediated stream (browser never touches MinIO).
ordersRouter.get('/orders/:id/photos', async (req, res) => {
  const photos = await listPhotos(req.params.id);
  res.json({
    photos: photos.map((p) => ({
      id: p.id, kind: p.kind, uploaded_by: p.uploaded_by, created_at: p.created_at,
      url: `/api/orders/${req.params.id}/photos/${p.id}/raw`,
    })),
  });
});

// Stream the actual bytes from MinIO through the backend (keeps storage creds off the client).
ordersRouter.get('/orders/:id/photos/:photoId/raw', async (req, res) => {
  try {
    const meta = await getPhoto(req.params.photoId);
    if (!meta || String(meta.order_id) !== String(req.params.id)) {
      return res.status(404).json({ error: 'not found' });
    }
    const { body, contentType } = await getObject(meta.object_key);
    res.setHeader('Content-Type', contentType || meta.content_type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=60');
    body.on('error', () => res.destroy());
    body.pipe(res);
  } catch (err) {
    res.status(404).json({ error: 'not found' });
  }
});

// User posts a chat message into the order thread.
ordersRouter.post('/orders/:id/messages', async (req, res) => {
  try {
    const { sender, body } = req.body || {};
    if (!body) return res.status(400).json({ error: 'body required' });
    const message = await postMessage({
      orderId: req.params.id,
      sender: sender === 'user' ? 'user' : 'user',
      body,
    });
    res.status(201).json({ message });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
