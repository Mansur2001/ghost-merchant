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
} from '../queries/orders.js';
import { getDriversWithStats, getDriverById } from '../queries/drivers.js';
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
    res.json({ operator: me });
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

// POST /api/operator/operators { username, displayName, phone }
// Creates the account with NO usable password and texts a setup code to `phone`; the person
// chooses their own password with it. Nobody types someone else's password anywhere.
operatorRouter.post('/operator/operators', adminOnly, async (req, res, next) => {
  try {
    const { username, displayName, phone } = req.body || {};
    const r = await createStaffAccount({
      role: 'operator', name: displayName || username, phone, username,
      createdBy: actorLabel(req.auth),
    });
    res.status(201).json(staffResult(r));
  } catch (err) {
    staffError(err, res, next);
  }
});

// POST /api/operator/operators/:id/active { active: bool } — deactivate/reactivate.
operatorRouter.post('/operator/operators/:id/active', adminOnly, async (req, res, next) => {
  try {
    const operator = await setOperatorActive(req.params.id, req.body?.active !== false, req.auth.id);
    res.json({ operator });
  } catch (err) {
    staffError(err, res, next);
  }
});

// POST /api/operator/operators/:id/admin { admin: bool }
operatorRouter.post('/operator/operators/:id/admin', adminOnly, async (req, res, next) => {
  try {
    const operator = await setOperatorAdmin(req.params.id, req.body?.admin === true);
    res.json({ operator });
  } catch (err) {
    staffError(err, res, next);
  }
});

// POST /api/operator/staff/:role/:id/setup-code — text a fresh setup code. Also how a
// forgotten PIN/password is reset: the old one keeps working until the new one is chosen.
operatorRouter.post('/operator/staff/:role/:id/setup-code', adminOnly, async (req, res, next) => {
  try {
    const r = await resendSetupCode({
      role: req.params.role, accountId: req.params.id, createdBy: actorLabel(req.auth),
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
operatorRouter.post('/operator/refunds/:id/settle', operatorOnly, async (req, res, next) => {
  try {
    const refund = await settleRefund({
      refundId: req.params.id,
      reference: req.body?.reference,
      note: req.body?.note,
      settledBy: actorLabel(req.auth),
    });
    res.json({ refund });
  } catch (err) {
    if (err instanceof RefundError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/operator/refunds/:id/waive { note }
// Closes a refund WITHOUT paying it. Separate from settle on purpose: conflating "we paid
// this back" with "nothing was owed" makes the ledger useless in the argument it exists for.
operatorRouter.post('/operator/refunds/:id/waive', operatorOnly, async (req, res, next) => {
  try {
    const refund = await waiveRefund({
      refundId: req.params.id,
      note: req.body?.note,
      settledBy: actorLabel(req.auth),
    });
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
    res.json({ requests });
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
    res.json({ request });
  } catch (err) {
    if (err instanceof AccessRequestError) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

// POST /api/operator/access-requests/:id/account { username? }
// Create the account an APPROVED request asked for, using the name/phone/role on the request,
// and text them a setup code. `username` is required for an operator.
operatorRouter.post('/operator/access-requests/:id/account', adminOnly, async (req, res, next) => {
  try {
    const r = await createStaffAccount({
      requestId: req.params.id,
      username: req.body?.username,
      createdBy: actorLabel(req.auth),
    });
    res.status(201).json(staffResult(r));
  } catch (err) {
    staffError(err, res, next);
  }
});

// GET /api/operator/drivers — roster with live workload stats (for the assign picker + panel).
operatorRouter.get('/operator/drivers', operatorOnly, async (req, res) => {
  res.json({ drivers: await getDriversWithStats() });
});

// POST /api/operator/orders/:id/assign  { driverId } — explicit operator→driver dispatch.
// From PAID_UNASSIGNED this assigns the driver AND transitions to DISPATCHED. If the order is
// already active it just re-assigns the driver (and notes it in the thread).
operatorRouter.post('/operator/orders/:id/assign', operatorOnly, async (req, res) => {
  try {
    const { driverId } = req.body || {};
    if (!driverId) return res.status(400).json({ error: 'driverId required' });
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'order not found' });
    const driver = await getDriverById(driverId);
    if (!driver || !driver.active) return res.status(400).json({ error: 'unknown or inactive driver' });

    // One transaction: an order must never end up assigned-but-not-dispatched (or the
    // reverse) because the process died between two writes.
    const result = await withTransaction(async (client) => {
      await assignDriver(order.id, driverId, { client });
      if (order.status === STATUS.PAID_UNASSIGNED) {
        return transitionOrder(
          order.id, STATUS.DISPATCHED, actorLabel(req.auth), `assigned to ${driver.name}`,
          { client }
        );
      }
      // Re-assignment on an already-dispatched/in-transit order (no status change).
      await postMessage(
        { orderId: order.id, sender: 'system', body: `Reassigned to driver ${driver.name}.` },
        { client }
      );
      return null;
    });
    wakeOutbox();
    res.json({ order: result || (await getOrder(order.id)) });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// POST /api/operator/orders/:id/mark-paid { reference? }
// THE way an order becomes paid: the operator saw the money on the merchant phone. Records the
// payment (so a later refund knows what is owed) and moves the order on, in one transaction.
// `reference` is the EVC/eDahab transaction id — unique, so one payment can't pay two orders.
operatorRouter.post('/operator/orders/:id/mark-paid', operatorOnly, async (req, res, next) => {
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
    res.json({ order });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// POST /api/operator/orders/:id/message — operator joins the chat thread.
operatorRouter.post('/operator/orders/:id/message', operatorOnly, async (req, res) => {
  const { body, clientId } = req.body || {};
  if (!body) return res.status(400).json({ error: 'body required' });
  const message = await postMessage({ orderId: req.params.id, sender: 'operator', body, clientId });
  res.json({ message });
});

// POST /api/operator/drivers  { name, msisdn } — admin adds a driver directly (no request).
// Same invite flow: the driver gets a setup code and chooses their own PIN. Never an upsert —
// typing an existing driver's number must not replace their PIN.
operatorRouter.post('/operator/drivers', adminOnly, async (req, res, next) => {
  try {
    const { name, msisdn } = req.body || {};
    const r = await createStaffAccount({
      role: 'driver', name, phone: msisdn, createdBy: actorLabel(req.auth),
    });
    res.status(201).json(staffResult(r));
  } catch (err) {
    staffError(err, res, next);
  }
});

// POST /api/operator/drivers/:id/active { active: bool } — take a driver off (or back on).
// Deactivated, never deleted: their deliveries reference them.
operatorRouter.post('/operator/drivers/:id/active', adminOnly, async (req, res, next) => {
  try {
    const driver = await prisma.driver.update({
      where: { id: BigInt(req.params.id) },
      data: { active: req.body?.active !== false },
      select: { id: true, name: true, active: true },
    });
    res.json({ driver });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'driver not found' });
    next(err);
  }
});
