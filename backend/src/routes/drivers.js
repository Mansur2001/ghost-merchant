// Driver PWA routes. PIN login -> token; queue; state transitions; item adjustments.
import { Router, raw } from 'express';
import { query } from '../db/pool.js';
import { verifySecret, signToken, requireRole } from '../middleware/auth.js';
import { transitionOrder, assignDriver, postMessage } from '../commands/orders.js';
import { savePhoto } from '../commands/photos.js';
import { getDriverQueue, getShoppingList } from '../queries/orders.js';
import { STATUS } from '../domain/stateMachine.js';
import { parseSomaliMsisdn } from '../domain/phone.js';

export const driversRouter = Router();

const rawImage = raw({ type: () => true, limit: '6mb' });

// POST /api/driver/login  { msisdn, pin }
driversRouter.post('/driver/login', async (req, res) => {
  const { msisdn, pin } = req.body || {};
  const phone = parseSomaliMsisdn(msisdn);
  const lookup = phone.valid ? phone.e164 : msisdn;
  const { rows } = await query(
    'SELECT * FROM drivers WHERE msisdn = $1 AND active = true',
    [lookup]
  );
  const driver = rows[0];
  if (!driver || !verifySecret(String(pin || ''), driver.pin_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = signToken({ role: 'driver', id: driver.id, name: driver.name });
  res.json({ token, driver: { id: driver.id, name: driver.name } });
});

const driverOnly = requireRole('driver');

// GET /api/driver/queue — unassigned paid orders + this driver's active orders.
driversRouter.get('/driver/queue', driverOnly, async (req, res) => {
  res.json({ orders: await getDriverQueue(req.auth.id) });
});

// GET /api/driver/orders/:id — full shopping list view.
driversRouter.get('/driver/orders/:id', driverOnly, async (req, res) => {
  const order = await getShoppingList(req.params.id);
  if (!order) return res.status(404).json({ error: 'not found' });
  res.json({ order });
});

// POST /api/driver/orders/:id/accept — claim a PAID_UNASSIGNED order.
driversRouter.post('/driver/orders/:id/accept', driverOnly, async (req, res) => {
  try {
    await assignDriver(req.params.id, req.auth.id);
    const order = await transitionOrder(
      req.params.id,
      STATUS.DISPATCHED,
      `driver:${req.auth.id}`,
      'driver accepted'
    );
    res.json({ order });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// POST /api/driver/orders/:id/secured — items in hand, heading to customer.
driversRouter.post('/driver/orders/:id/secured', driverOnly, async (req, res) => {
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
driversRouter.post('/driver/orders/:id/delivered', driverOnly, async (req, res) => {
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
driversRouter.post('/driver/orders/:id/failed', driverOnly, async (req, res) => {
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
driversRouter.post('/driver/orders/:id/delivery-proof', driverOnly, rawImage, async (req, res) => {
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
driversRouter.post('/driver/orders/:id/adjust', driverOnly, async (req, res) => {
  try {
    const { items, note } = req.body || {};
    await query('UPDATE orders SET items = $1, updated_at = now() WHERE id = $2', [
      JSON.stringify(items || []),
      req.params.id,
    ]);
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
