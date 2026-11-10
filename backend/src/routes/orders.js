// User-facing order + chat routes.
//
// AUTHORIZATION MODEL (read before adding a route here):
//   Every route that names an order takes `requireAuth, requireOrderAccess`. That pair is the
//   only thing standing between a stranger and a customer's phone number, home landmark,
//   chat, and photos. A new route without it is a data breach, not a missing feature.
//   The ownership rule itself lives in domain/access.js — don't re-implement it inline.
import { Router, raw } from 'express';
import { createOrder, postMessage, cancelOrder } from '../commands/orders.js';
import { placeOrder, quote } from '../commands/checkout.js';
import { startWalletPayment, snapshot } from '../commands/providerPayments.js';
import { latestAttempt } from '../queries/payments.js';
import { getCatalog, getPlaces } from '../queries/catalog.js';
import { getDriverLocationForOrder } from '../queries/drivers.js';
import { PricingError } from '../domain/pricing.js';
import { isInfraError } from '../middleware/errorHandler.js';
import { answer } from '../commands/assistant.js';
import { startTopup, payOrderFromWallet, requestWithdrawal, WalletError } from '../commands/wallet.js';
import { runTopup } from '../commands/providerPayments.js';
import { getWallet } from '../queries/wallet.js';
import { claimPayment, PaymentError } from '../commands/payments.js';
import { getOrder, getOrderTimeline, getMessages, getOrdersByUser, getHandoff, getProofs } from '../queries/orders.js';
import { savePhoto } from '../commands/photos.js';
import { disputeDelivery, ProofError } from '../commands/proofs.js';
import { listPhotos, getPhoto } from '../queries/photos.js';
import { getObject } from '../storage/objectStore.js';
import { buildPaymentInstruction } from '../domain/ussd.js';
import { parsePhone } from '../domain/phone.js';
import { senderForRole, canAccessOrder } from '../domain/access.js';
import { isUuid } from '../domain/ids.js';
import { requireAuth, requireRole, verifyToken } from '../middleware/auth.js';
import { sessionIsCurrent } from '../commands/sessions.js';
import { fileBug } from '../commands/bugs.js';
import { BugError } from '../domain/bugReport.js';
import { requireOrderAccess } from '../middleware/authorize.js';
import { rateLimit } from '../middleware/rateLimit.js';

export const ordersRouter = Router();

// Raw image body parser, scoped to photo-upload routes only (the global express.json skips
// non-JSON bodies, so image bytes pass through untouched to this). 6MB ceiling — photos are
// separate from the sub-10KB order payload budget.
const rawImage = raw({ type: () => true, limit: '6mb' });

const customerOnly = requireRole('customer');

// Live phone validation for the frontend (also the single source of truth). Public by
// necessity — it runs BEFORE anyone can have a session. It's a pure function over the input
// and touches no data, so the only abuse is volume; rate-limit and move on.
ordersRouter.get(
  '/phone/validate/:phone',
  rateLimit({ windowMs: 60 * 1000, max: 120 }),
  (req, res) => {
    res.json(parsePhone(req.params.phone));
  }
);

// GET /api/orders/mine — the authenticated customer's own orders (resume view).
// Replaces the old /orders/by-phone/:phone, which let anyone list any number's orders by
// typing it. The account now comes from the verified token and can't be chosen by the caller.
ordersRouter.get('/orders/mine', customerOnly, async (req, res) => {
  const orders = await getOrdersByUser(req.auth.uid);
  res.json({
    orders: orders.map((o) => ({ ...o, ...buildPaymentInstruction(o) })),
  });
});

// Create an order from the PWA checkout. Payload MUST stay sub-10KB.
// The owning account is taken from the session, NOT the body — otherwise a verified customer
// could create orders (and chat threads) in someone else's account. `phone` in the body is
// only the number the driver calls.
ordersRouter.post('/orders', customerOnly, async (req, res, next) => {
  try {
    const body = req.body || {};
    // `kind` = the priced checkout (commands/checkout.js). Without it: the legacy shape old
    // app builds send (a typed request and total), kept so they don't break mid-release.
    // `id` is the client's own UUID when it has one. Retrying a create whose response was
    // lost returns the SAME order (201 -> 200) instead of billing the customer twice.
    const { order, created } = body.kind
      ? await placeOrder({ userId: req.auth.uid, body })
      : await createOrder({
        id: body.id,
        userId: req.auth.uid,
        contactPhone: body.phone,
        items: body.items,
        totalAmount: body.totalAmount,
        lat: body.lat,
        lng: body.lng,
        landmark: body.landmark,
      });
    res.status(created ? 201 : 200).json({
      order,
      created,
      ...buildPaymentInstruction(order),
    });
  } catch (err) {
    if (err instanceof PricingError) {
      return res.status(err.status).json({ error: err.message, ...(err.quote ? { quote: err.quote } : {}) });
    }
    if (isInfraError(err)) return next(err);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/quote — what a job would cost, priced exactly as POST /orders will price it.
ordersRouter.post(
  '/quote',
  customerOnly,
  rateLimit({ windowMs: 60 * 1000, max: 60, message: 'too many requests' }),
  async (req, res, next) => {
    try {
      res.json({ quote: await quote(req.body || {}) });
    } catch (err) {
      if (err instanceof PricingError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  }
);

// The generic catalog and the fixed places. Public: the same for everyone, nothing personal,
// and the checkout needs it before sign-in is worth asking for.
ordersRouter.get('/catalog', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({ categories: await getCatalog() });
});

ordersRouter.get('/places', async (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({ places: await getPlaces() });
});

ordersRouter.get('/orders/:id', requireAuth, requireOrderAccess, (req, res) => {
  res.json({ order: req.order, ...buildPaymentInstruction(req.order) });
});

ordersRouter.get('/orders/:id/timeline', requireAuth, requireOrderAccess, async (req, res) => {
  res.json({ timeline: await getOrderTimeline(req.params.id) });
});

// The customer's delivery code: they read it to the driver at the door. Customer-only — a
// driver or operator who could read it could "prove" a delivery that never happened. Shown
// once the order is paid (before that there is nothing coming to hand over).
const HANDOFF_VISIBLE = ['PAID_UNASSIGNED', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED'];
ordersRouter.get('/orders/:id/handoff', customerOnly, requireOrderAccess, async (req, res) => {
  const handoff = HANDOFF_VISIBLE.includes(req.order.status) ? await getHandoff(req.params.id) : null;
  res.json({
    code: handoff && !handoff.verified_at && req.order.status !== 'DELIVERED' ? handoff.code : null,
    used: Boolean(handoff?.verified_at),
  });
});

// How each driver step was proven (photo, code, GPS distance). No code values in here.
ordersRouter.get('/orders/:id/proofs', requireAuth, requireOrderAccess, async (req, res) => {
  res.json({ proofs: await getProofs(req.params.id) });
});

// POST /api/orders/:id/dispute { note? } — the customer says the delivery never reached them.
ordersRouter.post(
  '/orders/:id/dispute',
  customerOnly,
  requireOrderAccess,
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: 'too many requests' }),
  async (req, res, next) => {
    try {
      await disputeDelivery({ orderId: req.params.id, note: req.body?.note });
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof ProofError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  }
);

ordersRouter.get('/orders/:id/messages', requireAuth, requireOrderAccess, async (req, res) => {
  res.json({ messages: await getMessages(req.params.id) });
});

// POST /api/orders/:id/paid { reference?, wallet? } — the customer says "I've paid".
// Tells the operator which order to check on the merchant phone. It does NOT mark the order
// paid: a button anyone can tap is not evidence of money. Only the operator's confirmation is.
ordersRouter.post(
  '/orders/:id/paid',
  customerOnly,
  requireOrderAccess,
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'too many requests' }),
  async (req, res, next) => {
    try {
      const order = await claimPayment({
        orderId: req.params.id,
        reference: req.body?.reference,
        wallet: req.body?.wallet,
      });
      res.json({ order });
    } catch (err) {
      if (err instanceof PaymentError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  }
);

// POST /api/orders/:id/cancel — before a driver has it. Paid already: a refund is opened.
ordersRouter.post(
  '/orders/:id/cancel',
  customerOnly,
  requireOrderAccess,
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'too many requests' }),
  async (req, res) => {
    const result = await cancelOrder({ orderId: req.params.id });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ order: result });
  }
);

// POST /api/orders/:id/pay { wallet, phone } — a WaafiPay prompt on the customer's phone.
// 202: the result comes over the socket (payment_attempt, then payment_confirmed).
ordersRouter.post(
  '/orders/:id/pay',
  customerOnly,
  requireOrderAccess,
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'too many requests' }),
  async (req, res, next) => {
    try {
      const attempt = await startWalletPayment({
        orderId: req.params.id,
        wallet: req.body?.wallet,
        phone: req.body?.phone,
      });
      res.status(202).json({ attempt: snapshot(attempt) });
    } catch (err) {
      if (err instanceof PaymentError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  }
);

// ── Customer wallet (WALLET_ENABLED). Money in only through the gateway; out only to pay an
// order or as a withdrawal an admin pays. See commands/wallet.js. ──
function walletError(err, res, next) {
  if (err instanceof WalletError) return res.status(err.status).json({ error: err.message });
  next(err);
}

ordersRouter.get('/wallet', customerOnly, async (req, res, next) => {
  try {
    res.json({ wallet: await getWallet(req.auth.uid) });
  } catch (err) {
    walletError(err, res, next);
  }
});

// POST /api/wallet/topup { amount, wallet, phone } — a WaafiPay prompt; credited when approved.
ordersRouter.post(
  '/wallet/topup',
  customerOnly,
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'too many requests' }),
  async (req, res, next) => {
    try {
      const attempt = await startTopup({
        userId: req.auth.uid, amount: req.body?.amount, wallet: req.body?.wallet, phone: req.body?.phone, run: runTopup,
      });
      res.status(202).json({ attempt: { id: attempt.id, status: attempt.status, amount: String(attempt.amount) } });
    } catch (err) {
      walletError(err, res, next);
    }
  }
);

// POST /api/orders/:id/pay-wallet — pay this order from the balance, all or nothing.
ordersRouter.post(
  '/orders/:id/pay-wallet',
  customerOnly,
  requireOrderAccess,
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'too many requests' }),
  async (req, res, next) => {
    try {
      const order = await payOrderFromWallet({ orderId: req.params.id, userId: req.auth.uid });
      res.json({ order });
    } catch (err) {
      walletError(err, res, next);
    }
  }
);

// POST /api/wallet/withdrawals { amount, phone } — cash out; an admin sends it and records it.
ordersRouter.post(
  '/wallet/withdrawals',
  customerOnly,
  rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: 'too many requests' }),
  async (req, res, next) => {
    try {
      const w = await requestWithdrawal({ userId: req.auth.uid, amount: req.body?.amount, phone: req.body?.phone });
      res.status(201).json({ withdrawal: { id: String(w.id), status: w.status } });
    } catch (err) {
      walletError(err, res, next);
    }
  }
);

ordersRouter.get('/orders/:id/payment', customerOnly, requireOrderAccess, async (req, res) => {
  res.json({ attempt: await latestAttempt(req.params.id) });
});

// Where the assigned driver is, for the map's first paint (the socket carries the rest).
// Only while they are on the way: before assignment there is no driver to show, and after the
// job the customer has no business knowing where that person went next.
ordersRouter.get('/orders/:id/driver-location', customerOnly, requireOrderAccess, async (req, res) => {
  const o = req.order;
  if (o.driver_id == null || !['DISPATCHED', 'IN_TRANSIT'].includes(o.status)) return res.json({ location: null });
  res.json({ location: await getDriverLocationForOrder(o.driver_id) });
});

// A live customer session if the request carries one, else nobody — for the public routes that
// do a little more for a signed-in customer. An expired or ended session is just "signed out"
// here (a session ended by a password change doesn't name its account either).
async function optionalCustomer(req) {
  const bearer = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const session = bearer ? verifyToken(bearer) : null;
  const live = session?.role === 'customer' && Number.isInteger(session.uid) && await sessionIsCurrent(session).catch(() => false);
  return live ? session : null;
}

// POST /api/assistant { message, history?, lang?, orderId? } — the help chat. Answers only:
// it can't change anything (domain/assistant.js). Public: people need help most before they
// have an account (signing in, paying). With an orderId it knows that order's status — and
// only if it is the signed-in caller's own (same rule as every order route, deny = 404).
ordersRouter.post(
  '/assistant',
  async (req, res, next) => {
    try {
      req.auth = await optionalCustomer(req);
      next();
    } catch (err) {
      next(err);
    }
  },
  // Per IP generously (many phones share one carrier IP), per account tightly: each answer can
  // cost a model call. Signed out, the IP is the identity.
  rateLimit({ windowMs: 10 * 60 * 1000, max: 120, message: 'too many questions — try again in a few minutes' }),
  rateLimit({ windowMs: 10 * 60 * 1000, max: 30, key: (req) => (req.auth ? `uid:${req.auth.uid}` : `anon:${req.ip}`), message: 'too many questions — try again in a few minutes' }),
  async (req, res, next) => {
    try {
      const { message, history, lang, orderId } = req.body || {};
      let order = null;
      if (orderId != null) {
        order = isUuid(orderId) ? await getOrder(orderId) : null;
        if (!order || !canAccessOrder(req.auth, order)) return res.status(404).json({ error: 'not found' });
      }
      res.json(await answer({ message, history, lang, order }));
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/bugs — Help -> Report a problem. Public on purpose (the team bug tracker's rule:
// zero friction, no account needed), so it is rate-limited and has a honeypot field. A
// signed-in customer's account is attached from the session, never from the body.
ordersRouter.post(
  '/bugs',
  rateLimit({ windowMs: 60 * 60 * 1000, max: 8, message: 'too many reports — try again later' }),
  async (req, res, next) => {
    // Bots fill every field; people never see this one.
    if (req.body?.website) return res.status(201).json({ data: { id: null, status: 'open' } });
    const userId = (await optionalCustomer(req))?.uid ?? null;
    try {
      const ack = await fileBug({ body: req.body || {}, userId, userAgent: req.get('User-Agent') });
      res.status(201).json({ data: ack });
    } catch (err) {
      if (err instanceof BugError) return res.status(err.status).json({ error: err.message, field: err.field });
      next(err);
    }
  }
);

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
    const { body, clientId } = req.body || {};
    if (!body) return res.status(400).json({ error: 'body required' });
    const sender = senderForRole(req.auth.role);
    if (!sender) return res.status(403).json({ error: 'forbidden' });
    // clientId makes a replayed (offline-queued) message land exactly once.
    const message = await postMessage({ orderId: req.params.id, sender, body, clientId });
    res.status(201).json({ message });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
