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
import { config } from '../config.js';
import { transitionOrder, postMessage, assignDriver } from '../commands/orders.js';
import {
  getActiveOrders,
  getUnmatchedTransactions,
  getOrder,
} from '../queries/orders.js';
import { getDriversWithStats, getDriverById } from '../queries/drivers.js';
import { STATUS } from '../domain/stateMachine.js';
import { parseSomaliMsisdn } from '../domain/phone.js';
import { oracleStatus } from '../realtime/oracleMonitor.js';

export const operatorRouter = Router();

// POST /api/operator/login  { password }
operatorRouter.post('/operator/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== config.operatorPassword) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  res.json({ token: signToken({ role: 'operator', id: 'super' }) });
});

const operatorOnly = requireRole('operator');

// GET /api/operator/orders — all active orders.
operatorRouter.get('/operator/orders', operatorOnly, async (req, res) => {
  res.json({ orders: await getActiveOrders() });
});

// GET /api/operator/oracle — Android Oracle health (dead-man's switch state).
operatorRouter.get('/operator/oracle', operatorOnly, (req, res) => {
  res.json(oracleStatus());
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

    await assignDriver(order.id, driverId);
    if (order.status === STATUS.PAID_UNASSIGNED) {
      const updated = await transitionOrder(
        order.id, STATUS.DISPATCHED, 'operator:super', `assigned to ${driver.name}`
      );
      return res.json({ order: updated });
    }
    // Re-assignment on an already-dispatched/in-transit order (no status change).
    await postMessage({ orderId: order.id, sender: 'system', body: `Reassigned to driver ${driver.name}.` });
    res.json({ order: await getOrder(order.id) });
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
      'operator:super',
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
    await withTransaction(async (client) => {
      await client.query(
        'UPDATE transactions SET order_id = $1, matched = true WHERE id = $2',
        [orderId, req.params.txId]
      );
    });
    const order = await getOrder(orderId);
    if (order.status === STATUS.PENDING_PAYMENT) {
      await transitionOrder(orderId, STATUS.PAID_UNASSIGNED, 'operator:super', 'manual receipt assign');
    }
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
      'operator:super',
      req.body?.reason || 'operator refund'
    );
    res.json({ order });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// POST /api/operator/orders/:id/message — operator joins the chat thread.
operatorRouter.post('/operator/orders/:id/message', operatorOnly, async (req, res) => {
  const { body } = req.body || {};
  if (!body) return res.status(400).json({ error: 'body required' });
  const message = await postMessage({ orderId: req.params.id, sender: 'operator', body });
  res.json({ message });
});

// POST /api/operator/drivers  { name, msisdn, pin } — admin creates a driver account.
operatorRouter.post('/operator/drivers', operatorOnly, async (req, res) => {
  try {
    const { name, msisdn, pin } = req.body || {};
    if (!name || !msisdn || !pin) {
      return res.status(400).json({ error: 'name, msisdn, pin required' });
    }
    const phone = parseSomaliMsisdn(msisdn);
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
