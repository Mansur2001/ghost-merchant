// Operator/dispatcher super-user dashboard routes. The manual-override surface that turns
// edge-case failures (Oracle down, wrong amount, ambiguous match) into a recoverable
// business rather than a broken one.
import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import {
  signToken,
  requireRole,
  hashSecret,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import {
  createOperator,
  verifyOperatorLogin,
  changeOwnPassword,
  setOperatorActive,
  OperatorError,
} from '../commands/operators.js';
import { listOperators, getOperatorById } from '../queries/operators.js';
import { normalizeUsername } from '../domain/operator.js';
import { actorLabel } from '../domain/redact.js';
import { transitionOrder, postMessage, assignDriver } from '../commands/orders.js';
import {
  getActiveOrders,
  getUnmatchedTransactions,
  getOrder,
} from '../queries/orders.js';
import { getDriversWithStats, getDriverById } from '../queries/drivers.js';
import { STATUS } from '../domain/stateMachine.js';
import { parsePhone } from '../domain/phone.js';
import { oracleStatus } from '../realtime/oracleMonitor.js';
import { wakeOutbox, outboxHealth } from '../events/outbox.js';

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
operatorRouter.get('/operator/operators', operatorOnly, async (req, res, next) => {
  try {
    res.json({ operators: await listOperators() });
  } catch (err) {
    next(err);
  }
});

// POST /api/operator/operators { username, displayName, password }
operatorRouter.post('/operator/operators', operatorOnly, async (req, res, next) => {
  try {
    const { username, displayName, password } = req.body || {};
    const operator = await createOperator({
      username,
      displayName,
      password,
      createdBy: actorLabel(req.auth),
    });
    res.status(201).json({ operator });
  } catch (err) {
    if (err instanceof OperatorError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/operator/operators/:id/active { active: bool } — deactivate/reactivate.
operatorRouter.post('/operator/operators/:id/active', operatorOnly, async (req, res, next) => {
  try {
    const operator = await setOperatorActive(req.params.id, req.body?.active !== false, req.auth.id);
    res.json({ operator });
  } catch (err) {
    if (err instanceof OperatorError) return res.status(err.status).json({ error: err.message });
    next(err);
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

// GET /api/operator/orders — all active orders.
operatorRouter.get('/operator/orders', operatorOnly, async (req, res) => {
  res.json({ orders: await getActiveOrders() });
});

// GET /api/operator/oracle — Android Oracle health (dead-man's switch state).
operatorRouter.get('/operator/oracle', operatorOnly, (req, res) => {
  res.json(oracleStatus());
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

// GET /api/operator/transactions/unmatched — reconciliation queue.
operatorRouter.get('/operator/transactions/unmatched', operatorOnly, async (req, res) => {
  res.json({ transactions: await getUnmatchedTransactions() });
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

// POST /api/operator/orders/:id/mark-paid — manual override when the Oracle failed
// or the auto-match couldn't resolve. Forces PENDING_PAYMENT -> PAID_UNASSIGNED.
operatorRouter.post('/operator/orders/:id/mark-paid', operatorOnly, async (req, res) => {
  try {
    const order = await transitionOrder(
      req.params.id,
      STATUS.PAID_UNASSIGNED,
      actorLabel(req.auth),
      req.body?.note || 'manual mark-paid override'
    );
    res.json({ order });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// POST /api/operator/transactions/:txId/assign  { orderId }
// Manually bind an unmatched receipt to an order and mark it paid.
operatorRouter.post('/operator/transactions/:txId/assign', operatorOnly, async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId required' });
    // Binding the receipt and marking the order paid is one decision, so it's one
    // transaction: a crash between them would leave a receipt claimed against an order that
    // still reads "awaiting payment" — the money-received-but-app-disagrees state.
    await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        'UPDATE transactions SET order_id = $1, matched = true WHERE id = $2',
        [orderId, req.params.txId]
      );
      if (rowCount === 0) throw new Error('receipt not found');
      const { rows } = await client.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [
        orderId,
      ]);
      if (!rows[0]) throw new Error('order not found');
      if (rows[0].status === STATUS.PENDING_PAYMENT) {
        await transitionOrder(orderId, STATUS.PAID_UNASSIGNED, actorLabel(req.auth),
          'manual receipt assign', { client });
      }
    });
    wakeOutbox();
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err.message });
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

// POST /api/operator/drivers  { name, msisdn, pin } — admin creates a driver account.
operatorRouter.post('/operator/drivers', operatorOnly, async (req, res) => {
  try {
    const { name, msisdn, pin } = req.body || {};
    if (!name || !msisdn || !pin) {
      return res.status(400).json({ error: 'name, msisdn, pin required' });
    }
    const phone = parsePhone(msisdn);
    if (!phone.valid) return res.status(400).json({ error: `driver number: ${phone.reason}` });
    const { rows } = await query(
      `INSERT INTO drivers(name, msisdn, pin_hash) VALUES ($1, $2, $3)
       ON CONFLICT (msisdn) DO UPDATE SET name = EXCLUDED.name, pin_hash = EXCLUDED.pin_hash
       RETURNING id, name, msisdn`,
      [name, phone.e164, hashSecret(String(pin))]
    );
    res.status(201).json({ driver: rows[0] });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
