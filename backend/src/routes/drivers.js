// Driver PWA routes. PIN login -> token; queue; state transitions; item adjustments.
import { Router, raw } from 'express';
import { prisma } from '../db/prisma.js';
import { verifySecret, signToken, requireRole } from '../middleware/auth.js';
import { requireOrderAccess } from '../middleware/authorize.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { transitionOrder, postMessage } from '../commands/orders.js';
import { savePhoto } from '../commands/photos.js';
import { confirmPickup, confirmDelivery, confirmDropoff, ProofError } from '../commands/proofs.js';
import { cleanReason } from '../domain/proof.js';
import { dispatchWaitingSoon, releaseOrder } from '../commands/dispatch.js';
import { setDriverOnline, recordDriverLocation } from '../commands/locations.js';
import { getDriverSelf } from '../queries/drivers.js';
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

// The two driver steps need evidence (domain/proof.js). The server checks it: an old app
// build, or a hand-made request, can't skip it.
function proofError(err, res, next) {
  if (err instanceof ProofError) return res.status(err.status).json({ error: err.message, ...err.extra });
  // An illegal transition from transitionOrder: a conflict, which the offline queue knows how
  // to read (it may simply be a replay that already landed).
  if (/^Illegal transition/.test(err.message)) return res.status(409).json({ error: err.message });
  next(err);
}

// POST /api/driver/orders/:id/secured  { fix? } — items in hand. Needs the pickup photo.
// A ride: { code } | { noCodeReason } — the rider's code proves the right person got in.
driversRouter.post('/driver/orders/:id/secured', ...myOrder, async (req, res, next) => {
  try {
    const order = await confirmPickup({
      orderId: req.params.id,
      actor: `driver:${req.auth.id}`,
      fix: req.body?.fix,
      code: req.body?.code,
      noCodeReason: req.body?.noCodeReason,
    });
    res.json({ order });
  } catch (err) {
    proofError(err, res, next);
  }
});

// POST /api/driver/orders/:id/delivered  { code } | { noCodeReason }, plus { fix? }
// The customer's 4-digit code is the proof. Without it: a door photo and a reason, flagged
// for an operator to check.
driversRouter.post('/driver/orders/:id/delivered', ...myOrder, async (req, res, next) => {
  try {
    const order = await confirmDelivery({
      orderId: req.params.id,
      actor: `driver:${req.auth.id}`,
      code: req.body?.code,
      noCodeReason: req.body?.noCodeReason,
      fix: req.body?.fix,
    });
    dispatchWaitingSoon(); // a job done is a driver free: give them the next one waiting
    res.json({ order });
  } catch (err) {
    proofError(err, res, next);
  }
});

// POST /api/driver/orders/:id/dropoff  { fix?, note? } — a ride is over.
driversRouter.post('/driver/orders/:id/dropoff', ...myOrder, async (req, res, next) => {
  try {
    const order = await confirmDropoff({
      orderId: req.params.id,
      actor: `driver:${req.auth.id}`,
      fix: req.body?.fix,
      note: req.body?.note,
    });
    dispatchWaitingSoon();
    res.json({ order });
  } catch (err) {
    proofError(err, res, next);
  }
});

// POST /api/driver/orders/:id/release { reason } — give a job back before pickup. It goes to
// the next free driver, never back to this one.
driversRouter.post('/driver/orders/:id/release', ...myOrder, async (req, res) => {
  const reason = cleanReason(req.body?.reason);
  if (!reason) return res.status(400).json({ error: 'say why you can\'t take it' });
  const result = await releaseOrder({ orderId: req.params.id, driverId: req.auth.id, reason });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json(result);
});

// GET /api/driver/me — the switch and vehicle the app shows.
driversRouter.get('/driver/me', driverOnly, async (req, res) => {
  const me = await getDriverSelf(req.auth.id);
  if (!me) return res.status(404).json({ error: 'not found' });
  res.json({ driver: me });
});

// POST /api/driver/online { online } — "I want work" on or off. Going online can hand the
// driver a waiting job at once; going offline keeps the jobs they already have.
driversRouter.post('/driver/online', driverOnly, async (req, res) => {
  if (typeof req.body?.online !== 'boolean') return res.status(400).json({ error: 'online must be true or false' });
  const driver = await setDriverOnline({ driverId: req.auth.id, online: req.body.online });
  if (driver.online) dispatchWaitingSoon();
  res.json({ driver });
});

// POST /api/driver/location { lat, lng, accuracy?, heading?, speed? } — the HTTP path for a
// position, for when the socket is down. The socket `location` frame is the usual one.
driversRouter.post(
  '/driver/location',
  driverOnly,
  rateLimit({ windowMs: 60 * 1000, max: 30, message: 'too many updates' }),
  async (req, res) => {
    const saved = await recordDriverLocation({ driverId: req.auth.id, raw: req.body });
    // null = too soon after the last one: dropped, not wrong (the next one will land).
    if (saved === false) return res.status(400).json({ error: 'not a usable position' });
    res.json({ ok: true });
  }
);

// POST /api/driver/orders/:id/failed  { reason } — a reason is required: it is what the
// operator reads before deciding what is owed.
driversRouter.post('/driver/orders/:id/failed', ...myOrder, async (req, res) => {
  const reason = cleanReason(req.body?.reason);
  if (!reason) return res.status(400).json({ error: 'say what went wrong' });
  try {
    const order = await transitionOrder(
      req.params.id,
      STATUS.FAILED_REFUND,
      `driver:${req.auth.id}`,
      reason
    );
    dispatchWaitingSoon();
    res.json({ order });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// Evidence photos (raw image bytes), each accepted only while its step is open. The object
// key is deterministic per (order, kind), so a later upload would REPLACE the photo a
// confirmed step rests on; once the step is done, its photo is frozen.
const PROOF_PHOTO_OPEN = {
  pickup_proof: [STATUS.DISPATCHED],
  delivery_proof: [STATUS.IN_TRANSIT],
};
function proofPhotoRoute(kind) {
  return async (req, res) => {
    if (!PROOF_PHOTO_OPEN[kind].includes(req.order.status)) {
      return res.status(409).json({ error: 'this step is already done — its photo can\'t change' });
    }
    try {
      const photo = await savePhoto({
        orderId: req.params.id,
        kind,
        bytes: req.body,
        contentType: req.get('Content-Type'),
        uploadedBy: `driver:${req.auth.id}`,
      });
      res.status(201).json({ photo });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };
}
driversRouter.post('/driver/orders/:id/pickup-proof', ...myOrder, rawImage, proofPhotoRoute('pickup_proof'));
driversRouter.post('/driver/orders/:id/delivery-proof', ...myOrder, rawImage, proofPhotoRoute('delivery_proof'));

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
