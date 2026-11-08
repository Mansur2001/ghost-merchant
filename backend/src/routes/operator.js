// Operator/dispatcher dashboard routes. Payments are confirmed here — an operator checks the
// merchant phone and confirms each one — plus dispatch, refunds, and (admins) staff management.
import { Router } from 'express';
import { prisma, withTransaction } from '../db/prisma.js';
import { signToken, requireRole } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import {
  verifyOperatorLogin,
  changeOwnPassword,
  setOperatorActive,
  setOperatorAdmin,
  OperatorError,
} from '../commands/operators.js';
import { createStaffAccount, resendSetupCode, StaffError } from '../commands/staffAccounts.js';
import { config } from '../config.js';
import { listOperators, getOperatorById } from '../queries/operators.js';
import { normalizeUsername } from '../domain/operator.js';
import { actorLabel } from '../domain/redact.js';
import { transitionOrder, postMessage, assignDriver } from '../commands/orders.js';
import {
  getActiveOrders,
  getOrder,
  getRecentDeliveries,
} from '../queries/orders.js';
import { markProofReviewed, ProofError } from '../commands/proofs.js';
import { getDriversWithStats, getDriverById, getDriverPositions } from '../queries/drivers.js';
import { getCatalog, getPlaces } from '../queries/catalog.js';
import { createEntry, updateEntry, CatalogError } from '../commands/catalog.js';
import { STATUS } from '../domain/stateMachine.js';
import { wakeOutbox, outboxHealth } from '../events/outbox.js';
import {
  listOutstandingRefunds,
  listSettledRefunds,
  settleRefund,
  waiveRefund,
  RefundError,
} from '../commands/refunds.js';
import {
  listAccessRequests,
  reviewAccessRequest,
  AccessRequestError,
} from '../commands/accessRequests.js';
import { getObject } from '../storage/objectStore.js';
import { confirmPayment, PaymentError } from '../commands/payments.js';
import { audit, auditAfter } from '../commands/audit.js';
import { dispatchWaitingSoon } from '../commands/dispatch.js';
import { isUuid } from '../domain/ids.js';

export const operatorRouter = Router();

// POST /api/operator/login  { username, password }
// Named accounts (P0 #5): every action below is attributed to a specific person in
// order_events.actor, which is the record we rely on in a payment dispute. Limited per-IP and
// per-username — this surface can read every order and drive every state machine.
operatorRouter.post(
  '/operator/login',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'too many login attempts' }),
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    key: (req) => normalizeUsername(req.body?.username).slice(0, 32) || 'unknown',
    message: 'too many login attempts',
  }),
  async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      const operator = await verifyOperatorLogin(username, password);
      // One error for both "no such account" and "wrong password": the difference would
      // enumerate the staff roster.
      if (!operator) return res.status(401).json({ error: 'invalid credentials' });
      const token = signToken({
        role: 'operator',
        id: operator.id,
        username: operator.username,
        name: operator.display_name,
      });
      res.json({
        token,
        operator: {
          id: operator.id,
          username: operator.username,
          displayName: operator.display_name,
          mustChangePassword: operator.must_change_password,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

const operatorOnly = requireRole('operator');

// Staff management is ADMIN-only: creating accounts, disabling them, reading applicants' IDs.
// Checked against the database on every request rather than trusted from the token, so
// removing someone's admin rights takes effect immediately, not when their session expires.
// (403 is fine here: unlike an order, there's no hidden object whose existence it would leak.)
const adminOnly = [
  operatorOnly,
  async (req, res, next) => {
    try {
      const op = await prisma.operator.findUnique({
        where: { id: BigInt(req.auth.id) },
        select: { is_admin: true, active: true },
      });
      if (!op?.active || !op.is_admin) return res.status(403).json({ error: 'admins only' });
      next();
    } catch (err) {
      next(err);
    }
  },
];

// What a create/resend answers. The code itself appears ONLY in development with the log
// transport (no SMS was sent, so the screen is the only way to see it) — never in production.
function staffResult(r) {
  const body = {
    role: r.role,
    account: r.account,
    smsSent: Boolean(r.transport),
    sentVia: r.sentVia,
    error: r.smsError || undefined,
  };
  if (r.transport === 'log' && config.env !== 'production') body.devCode = r.code;
  return body;
}

function staffError(err, res, next) {
  if (err instanceof StaffError || err instanceof OperatorError) {
    return res.status(err.status).json({ error: err.message });
  }
  return next(err);
}

// Who is signed in — lets the dashboard show the name and nag about a bootstrap password.
operatorRouter.get('/operator/me', operatorOnly, async (req, res, next) => {
  try {
    const me = await getOperatorById(req.auth.id);
    if (!me) return res.status(401).json({ error: 'unauthorized' }); // deactivated mid-session
    // The console hides controls this server doesn't allow (e.g. confirm payment in api mode).
    res.json({ operator: me, settings: { paymentConfirmation: config.paymentConfirmation } });
  } catch (err) {
    next(err);
  }
});

// ── Operator account management ──
operatorRouter.get('/operator/operators', adminOnly, async (req, res, next) => {
  try {
    res.json({ operators: await listOperators() });
  } catch (err) {
    next(err);
  }
});

// POST /api/operator/operators { username, displayName, phone, email? }
// Creates the account with NO usable password and texts a setup code to `phone` (or emails
// it, if `email` is given); the person chooses their own password with it. Nobody types
// someone else's password anywhere.
operatorRouter.post('/operator/operators', adminOnly, async (req, res, next) => {
  try {
    const { username, displayName, phone, email } = req.body || {};
    const r = await createStaffAccount({
      role: 'operator', name: displayName || username, phone, username, email,
      createdBy: actorLabel(req.auth),
    });
    auditAfter({ actor: actorLabel(req.auth), action: 'staff.created', subject: `operator:${r.account?.id}`, detail: { username } });
    res.status(201).json(staffResult(r));
  } catch (err) {
    staffError(err, res, next);
  }
});

// POST /api/operator/operators/:id/active { active: bool } — deactivate/reactivate.
operatorRouter.post('/operator/operators/:id/active', adminOnly, async (req, res, next) => {
  try {
    const operator = await setOperatorActive(req.params.id, req.body?.active !== false, req.auth.id);
    auditAfter({ actor: actorLabel(req.auth), action: 'staff.active', subject: `operator:${req.params.id}`, detail: { active: req.body?.active !== false } });
    res.json({ operator });
  } catch (err) {
    staffError(err, res, next);
  }
});

// POST /api/operator/operators/:id/admin { admin: bool }
operatorRouter.post('/operator/operators/:id/admin', adminOnly, async (req, res, next) => {
  try {
    const operator = await setOperatorAdmin(req.params.id, req.body?.admin === true);
    auditAfter({ actor: actorLabel(req.auth), action: 'staff.admin', subject: `operator:${req.params.id}`, detail: { admin: req.body?.admin === true } });
    res.json({ operator });
  } catch (err) {
    staffError(err, res, next);
  }
});

// POST /api/operator/staff/:role/:id/setup-code { email?, via? } — send a fresh setup code,
// by email if one is given or on file, otherwise by text. Also how a forgotten PIN/password is
// reset: the old one keeps working until the new one is chosen.
operatorRouter.post('/operator/staff/:role/:id/setup-code', adminOnly, async (req, res, next) => {
  try {
    const r = await resendSetupCode({
      role: req.params.role, accountId: req.params.id, createdBy: actorLabel(req.auth),
      email: req.body?.email, via: req.body?.via,
    });
    res.json(staffResult(r));
  } catch (err) {
    staffError(err, res, next);
  }
});

// POST /api/operator/me/password { currentPassword, newPassword }
operatorRouter.post(
  '/operator/me/password',
  operatorOnly,
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'too many attempts' }),
  async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body || {};
      await changeOwnPassword({ operatorId: req.auth.id, currentPassword, newPassword });
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof OperatorError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  }
);

// GET /api/operator/orders — all active orders. A claim names its wallet; attach that
// wallet's merchant number so the operator knows which phone to check for the money.
operatorRouter.get('/operator/orders', operatorOnly, async (req, res) => {
  const wallets = config.payment.wallets;
  const orders = (await getActiveOrders()).map((o) => {
    const w = wallets.find((x) => x.id === o.payment_claim_wallet);
    return { ...o, claim_wallet: w ? { name: w.name, merchant: w.merchant } : null };
  });
  res.json({ orders });
});

// GET /api/operator/outbox — event-relay backlog. A growing `pending` count means committed
// state is not reaching clients: the app looks frozen even though the data is fine.
operatorRouter.get('/operator/outbox', operatorOnly, async (req, res, next) => {
  try {
    res.json(await outboxHealth());
  } catch (err) {
    next(err);
  }
});

// ── Refunds: money we owe customers ──
//
// The platform never holds funds, so a refund is an operator sending money back from their
// own phone. These endpoints are the ledger that makes that debt visible and closeable.

// GET /api/operator/refunds — what is still owed, plus recently closed for context.
operatorRouter.get('/operator/refunds', operatorOnly, async (req, res, next) => {
  try {
    const [outstanding, settled] = await Promise.all([
      listOutstandingRefunds(),
      listSettledRefunds(),
    ]);
    res.json({ ...outstanding, settled });
  } catch (err) {
    next(err);
  }
});

// POST /api/operator/refunds/:id/settle { reference, note }
// The reference is the telecom receipt for the RETURN transfer — the only thing that can be
// checked against the telecom's own records in a dispute, so it is required.
// Money going back to a customer is an ADMIN's decision, never an ordinary operator's: an
// operator who could record "refunded" could close a debt that was never paid.
operatorRouter.post('/operator/refunds/:id/settle', adminOnly, async (req, res, next) => {
  try {
    const refund = await settleRefund({
      refundId: req.params.id,
      reference: req.body?.reference,
      note: req.body?.note,
      settledBy: actorLabel(req.auth),
    });
    auditAfter({ actor: actorLabel(req.auth), action: 'refund.settled', subject: `refund:${req.params.id}`, detail: { reference: req.body?.reference || null } });
    res.json({ refund });
  } catch (err) {
    if (err instanceof RefundError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/operator/refunds/:id/waive { note }
// Closes a refund WITHOUT paying it. Separate from settle on purpose: conflating "we paid
// this back" with "nothing was owed" makes the ledger useless in the argument it exists for.
operatorRouter.post('/operator/refunds/:id/waive', adminOnly, async (req, res, next) => {
  try {
    const refund = await waiveRefund({
      refundId: req.params.id,
      note: req.body?.note,
      settledBy: actorLabel(req.auth),
    });
    auditAfter({ actor: actorLabel(req.auth), action: 'refund.waived', subject: `refund:${req.params.id}`, detail: { note: req.body?.note || null } });
    res.json({ refund });
  } catch (err) {
    if (err instanceof RefundError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ── Access requests: people asking to be given an account ──

// GET /api/operator/access-requests
operatorRouter.get('/operator/access-requests', adminOnly, async (req, res, next) => {
  try {
    const requests = await listAccessRequests({ includeClosed: req.query.all === '1' });
    // BLIND review: until a decision is made, the reviewer sees the role, the typed name and the
    // ID — enough to check that the two match — and nothing that says who the person is to
    // them (phone, email, their message). Contact details unlock once the decision is recorded.
    const decided = (r) => r.status === 'approved' || r.status === 'declined';
    res.json({
      requests: requests.map((r) => (decided(r) ? r : { ...r, phone: null, email: null, message: null, blind: true })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/operator/access-requests/:id/id-document — stream the ID image.
//
// Operator-only, streamed through the backend so object storage is never browser-reachable,
// and no-store so it doesn't sit in a disk cache on the dispatch machine.
operatorRouter.get('/operator/access-requests/:id/id-document/:side', adminOnly, async (req, res, next) => {
  try {
    const request = await prisma.accessRequest.findUnique({ where: { id: BigInt(req.params.id) } });
    const key = req.params.side === 'back' ? request?.id_back_key : request?.id_front_key;
    if (!key) return res.status(404).json({ error: 'not found' });
    const { body, contentType } = await getObject(key);
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    body.on('error', () => res.destroy());
    body.pipe(res);
  } catch (err) {
    if (err?.name === 'NoSuchKey') return res.status(404).json({ error: 'not found' });
    next(err);
  }
});

// POST /api/operator/access-requests/:id/review { status, note }
// Records the decision only. Approving does NOT create an account — that is the separate
// POST .../account below, because minting a credential should be a deliberate act, not a
// side effect of clicking a button in a list.
operatorRouter.post('/operator/access-requests/:id/review', adminOnly, async (req, res, next) => {
  try {
    const request = await reviewAccessRequest({
      requestId: req.params.id,
      status: req.body?.status,
      note: req.body?.note,
      reviewedBy: actorLabel(req.auth),
    });
    auditAfter({ actor: actorLabel(req.auth), action: 'access.reviewed', subject: `access_request:${req.params.id}`, detail: { status: req.body?.status } });
    res.json({ request });
  } catch (err) {
    if (err instanceof AccessRequestError) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

// POST /api/operator/access-requests/:id/account { username?, email? }
// Create the account an APPROVED request asked for, using the name/phone/role on the request,
// and text them a setup code. `username` is required for an operator.
operatorRouter.post('/operator/access-requests/:id/account', adminOnly, async (req, res, next) => {
  try {
    const r = await createStaffAccount({
      requestId: req.params.id,
      username: req.body?.username,
      email: req.body?.email,
      createdBy: actorLabel(req.auth),
    });
    auditAfter({ actor: actorLabel(req.auth), action: 'staff.created', subject: `${r.role}:${r.account?.id}`, detail: { fromRequest: req.params.id } });
    if (r.role === 'driver') dispatchWaitingSoon();
    res.status(201).json(staffResult(r));
  } catch (err) {
    staffError(err, res, next);
  }
});

// GET /api/operator/drivers — roster with live workload stats (for the assign picker + panel).
operatorRouter.get('/operator/drivers', operatorOnly, async (req, res) => {
  res.json({ drivers: await getDriversWithStats() });
});

// NOTE: there is no assign route. Operators don't choose drivers: a paid order is dispatched
// automatically (commands/dispatch.js), so nobody at the desk can favour or punish a driver.

// POST /api/operator/orders/:id/mark-paid { reference? }
// THE way an order becomes paid: the operator saw the money on the merchant phone. Records the
// payment (so a later refund knows what is owed) and moves the order on, in one transaction.
// `reference` is the EVC/eDahab transaction id — unique, so one payment can't pay two orders.
operatorRouter.post('/operator/orders/:id/mark-paid', operatorOnly, async (req, res, next) => {
  // Once the provider's API is live, no person can mark an order paid — only its signed callback.
  if (config.paymentConfirmation === 'api') {
    return res.status(403).json({ error: 'payments are confirmed automatically by the mobile-money API' });
  }
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'order not found' });
  try {
    const order = await confirmPayment({
      orderId: req.params.id,
      reference: req.body?.reference,
      actor: actorLabel(req.auth),
    });
    res.json({ order });
  } catch (err) {
    if (err instanceof PaymentError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/operator/orders/:id/refund — mark an order failed/refund (manual money return
// happens off-platform via the same EVC Plus flow; this records it + notifies the user).
operatorRouter.post('/operator/orders/:id/refund', operatorOnly, async (req, res) => {
  try {
    const order = await transitionOrder(
      req.params.id,
      STATUS.FAILED_REFUND,
      actorLabel(req.auth),
      req.body?.reason || 'operator refund'
    );
    // Failing a paid order opens a refund (owed) — it moves no money, and only an admin can
    // close the debt. Logged like every other decision.
    auditAfter({ actor: actorLabel(req.auth), action: 'order.failed', subject: `order:${req.params.id}`, detail: { reason: req.body?.reason || null } });
    dispatchWaitingSoon(); // its driver, if any, is free again
    res.json({ order });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// GET /api/operator/deliveries — the last week's deliveries with their proof, the ones that
// need a look (no code, no GPS, far from the pin) and haven't had one first.
operatorRouter.get('/operator/deliveries', operatorOnly, async (req, res) => {
  res.json({ deliveries: await getRecentDeliveries() });
});

// POST /api/operator/orders/:id/proofs/review — "I checked this delivery". Records who.
operatorRouter.post('/operator/orders/:id/proofs/review', operatorOnly, async (req, res, next) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'order not found' });
  try {
    await markProofReviewed({ orderId: req.params.id, actor: actorLabel(req.auth) });
    auditAfter({ actor: actorLabel(req.auth), action: 'delivery.checked', subject: `order:${req.params.id}` });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ProofError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/operator/orders/:id/message — operator joins the chat thread.
operatorRouter.post('/operator/orders/:id/message', operatorOnly, async (req, res) => {
  const { body, clientId } = req.body || {};
  if (!body) return res.status(400).json({ error: 'body required' });
  const message = await postMessage({ orderId: req.params.id, sender: 'operator', body, clientId });
  res.json({ message });
});

// POST /api/operator/drivers  { name, msisdn, email? } — admin adds a driver directly (no request).
// Same invite flow: the driver gets a setup code and chooses their own PIN. Never an upsert —
// typing an existing driver's number must not replace their PIN.
operatorRouter.post('/operator/drivers', adminOnly, async (req, res, next) => {
  try {
    const { name, msisdn, email } = req.body || {};
    const r = await createStaffAccount({
      role: 'driver', name, phone: msisdn, email, createdBy: actorLabel(req.auth),
    });
    auditAfter({ actor: actorLabel(req.auth), action: 'staff.created', subject: `driver:${r.account?.id}`, detail: { name } });
    res.status(201).json(staffResult(r));
  } catch (err) {
    staffError(err, res, next);
  }
});

// POST /api/operator/drivers/:id/active { active: bool } — take a driver off (or back on).
// Deactivated, never deleted: their deliveries reference them.
operatorRouter.post('/operator/drivers/:id/active', adminOnly, async (req, res, next) => {
  try {
    const active = req.body?.active !== false;
    // Taking a driver off with goods or jobs in hand would strand those orders: dispatch only
    // ever hands work TO drivers, so nobody could move it. Finish or fail them first.
    if (!active) {
      const busy = await prisma.order.count({
        where: { driver_id: BigInt(req.params.id), status: { in: ['DISPATCHED', 'IN_TRANSIT'] } },
      });
      if (busy) return res.status(409).json({ error: `this driver has ${busy} active order(s) — they must finish or fail them first` });
    }
    const driver = await prisma.driver.update({
      where: { id: BigInt(req.params.id) },
      data: { active },
      select: { id: true, name: true, active: true },
    });
    auditAfter({ actor: actorLabel(req.auth), action: 'staff.active', subject: `driver:${req.params.id}`, detail: { active } });
    if (active) dispatchWaitingSoon();
    res.json({ driver });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'driver not found' });
    next(err);
  }
});

// POST /api/operator/drivers/:id/vehicle { vehicle } — what they drive decides which rides they
// get (a car rider never gets a bajaj). Admins only, like the rest of the roster.
operatorRouter.post('/operator/drivers/:id/vehicle', adminOnly, async (req, res, next) => {
  try {
    const vehicle = req.body?.vehicle;
    if (!['bajaj', 'car', 'moto'].includes(vehicle)) return res.status(400).json({ error: 'vehicle is bajaj, car or moto' });
    const driver = await prisma.driver.update({
      where: { id: BigInt(req.params.id) },
      data: { vehicle },
      select: { id: true, name: true, vehicle: true },
    });
    auditAfter({ actor: actorLabel(req.auth), action: 'staff.vehicle', subject: `driver:${req.params.id}`, detail: { vehicle } });
    dispatchWaitingSoon();
    res.json({ driver });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'driver not found' });
    next(err);
  }
});

// GET /api/operator/map — drivers' latest positions and what they carry. Live updates come
// over the socket (driver_location).
operatorRouter.get('/operator/map', operatorOnly, async (req, res, next) => {
  try {
    res.json({ drivers: await getDriverPositions() });
  } catch (err) {
    next(err);
  }
});

// ── Catalog and places (admins). Nothing is deleted; `active: false` hides. ──
function catalogError(err, res, next) {
  if (err instanceof CatalogError) return res.status(err.status).json({ error: err.message });
  next(err);
}

operatorRouter.get('/operator/catalog', operatorOnly, async (req, res, next) => {
  try {
    res.json({ categories: await getCatalog({ includeInactive: true }), places: await getPlaces({ includeInactive: true }) });
  } catch (err) {
    next(err);
  }
});

// Written out route by route (not a loop) so every path is greppable and the API-doc test
// can see it.
const createRoute = (kind) => async (req, res, next) => {
  try {
    res.status(201).json({ [kind]: await createEntry(kind, req.body, actorLabel(req.auth)) });
  } catch (err) {
    catalogError(err, res, next);
  }
};
const updateRoute = (kind) => async (req, res, next) => {
  try {
    res.json({ [kind]: await updateEntry(kind, req.params.id, req.body, actorLabel(req.auth)) });
  } catch (err) {
    catalogError(err, res, next);
  }
};
operatorRouter.post('/operator/catalog/categories', adminOnly, createRoute('category'));
operatorRouter.patch('/operator/catalog/categories/:id', adminOnly, updateRoute('category'));
operatorRouter.post('/operator/catalog/items', adminOnly, createRoute('item'));
operatorRouter.patch('/operator/catalog/items/:id', adminOnly, updateRoute('item'));
operatorRouter.post('/operator/places', adminOnly, createRoute('place'));
operatorRouter.patch('/operator/places/:id', adminOnly, updateRoute('place'));

// GET /api/operator/audit — the append-only decision log, newest first. Admins only: it names
// staff and customers' orders, and it is the record a dispute is settled with.
operatorRouter.get('/operator/audit', adminOnly, async (req, res, next) => {
  try {
    const entries = await prisma.auditLog.findMany({ orderBy: { at: 'desc' }, take: 300 });
    res.json({ entries });
  } catch (err) {
    next(err);
  }
});
