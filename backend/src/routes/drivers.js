// Driver PWA routes. PIN login -> token; queue; state transitions; item adjustments.
import { Router, raw } from 'express';
import { prisma } from '../db/prisma.js';
import { verifySecret, signToken, requireRole } from '../middleware/auth.js';
import { requireOrderAccess } from '../middleware/authorize.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { transitionOrder, postMessage } from '../commands/orders.js';
import { savePhoto } from '../commands/photos.js';
import { getDriverQueue, getShoppingList } from '../queries/orders.js';
import { STATUS } from '../domain/stateMachine.js';
import { parsePhone } from '../domain/phone.js';

export const driversRouter = Router();

const rawImage = raw({ type: () => true, limit: '6mb' });

// A 4-digit PIN is 10,000 possibilities — trivially brute-forced at line speed without this.
// Limited per-IP and per-msisdn so neither one host nor one targeted driver can be ground down.
const loginLimits = [
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'too many login attempts' }),
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    key: (req) => String(req.body?.msisdn || 'unknown').slice(0, 24),
    message: 'too many login attempts',
  }),
];

// POST /api/driver/login  { msisdn, pin }
driversRouter.post('/driver/login', ...loginLimits, async (req, res) => {
  const { msisdn, pin } = req.body || {};
  const phone = parsePhone(msisdn);
  const lookup = phone.valid ? phone.e164 : msisdn;
  const driver = await prisma.driver.findFirst({ where: { msisdn: lookup, active: true } });
  if (!driver || !verifySecret(String(pin || ''), driver.pin_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = signToken({ role: 'driver', id: driver.id, name: driver.name });
  res.json({ token, driver: { id: driver.id, name: driver.name } });
});

const driverOnly = requireRole('driver');
// Every :id route below is additionally gated on "the operator assigned this order to ME"
// (domain/access.js). Without it, any logged-in driver could drive any order's state machine
// — mark a stranger's order delivered, or read their address off the shopping list.
const myOrder = [driverOnly, requireOrderAccess];

// GET /api/driver/queue — only what the operator assigned to this driver.
driversRouter.get('/driver/queue', driverOnly, async (req, res) => {
  res.json({ orders: await getDriverQueue(req.auth.id) });
});

// GET /api/driver/orders/:id — full shopping list view.
driversRouter.get('/driver/orders/:id', ...myOrder, async (req, res) => {
  const order = await getShoppingList(req.params.id);
  if (!order) return res.status(404).json({ error: 'not found' });
  res.json({ order });
});

// NOTE: the old POST /driver/orders/:id/accept (self-serve claim of a PAID_UNASSIGNED order)
// was removed. Dispatch is operator-driven: a driver only ever works orders the operator
// assigned, so "accept" contradicted the model and was the one route that needed to bypass
// the assignment check. Assignment happens at POST /operator/orders/:id/assign.

// POST /api/driver/orders/:id/secured — items in hand, heading to customer.
driversRouter.post('/driver/orders/:id/secured', ...myOrder, async (req, res) => {
  try {
    const order = await transitionOrder(
      req.params.id,
      STATUS.IN_TRANSIT,
      `driver:${req.auth.id}`,
      'items secured'
    );
    res.json({ order });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// POST /api/driver/orders/:id/delivered
driversRouter.post('/driver/orders/:id/delivered', ...myOrder, async (req, res) => {
  try {
    const order = await transitionOrder(
      req.params.id,
      STATUS.DELIVERED,
      `driver:${req.auth.id}`,
      'delivered'
    );
    res.json({ order });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// POST /api/driver/orders/:id/failed  { reason }
driversRouter.post('/driver/orders/:id/failed', ...myOrder, async (req, res) => {
  try {
    const order = await transitionOrder(
      req.params.id,
      STATUS.FAILED_REFUND,
      `driver:${req.auth.id}`,
      req.body?.reason || 'driver reported failure'
    );
    res.json({ order });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// POST /api/driver/orders/:id/delivery-proof — driver uploads a proof-of-delivery photo
// (raw image bytes). Stored in MinIO; posts a system line into the thread for live sync.
driversRouter.post('/driver/orders/:id/delivery-proof', ...myOrder, rawImage, async (req, res) => {
  try {
    const photo = await savePhoto({
      orderId: req.params.id,
      kind: 'delivery_proof',
      bytes: req.body,
      contentType: req.get('Content-Type'),
      uploadedBy: `driver:${req.auth.id}`,
    });
    res.status(201).json({ photo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/driver/orders/:id/adjust  { items } — out-of-stock / price adjustment.
// Records the new item list and drops a note into the chat so the customer sees it.
driversRouter.post('/driver/orders/:id/adjust', ...myOrder, async (req, res) => {
  try {
    const { items, note } = req.body || {};
    await prisma.order.update({
      where: { id: req.params.id },
      data: { items: items || [], updated_at: new Date() },
    });
    await postMessage({
      orderId: req.params.id,
      sender: 'driver',
      body: note || 'Driver adjusted your order (stock/price change).',
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
