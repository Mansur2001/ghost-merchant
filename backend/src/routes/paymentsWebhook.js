// The mobile-money provider's callback: the ONLY way an order becomes paid when
// PAYMENT_CONFIRMATION=api. Mounted before the global JSON parser, because the signature
// covers the exact bytes sent — re-serialised JSON would never match.
import { Router, raw } from 'express';
import { config } from '../config.js';
import { prisma } from '../db/prisma.js';
import { verifyWebhook } from '../domain/paymentWebhook.js';
import { normalizeReference } from '../domain/paymentRef.js';
import { isUuid } from '../domain/ids.js';
import { confirmPayment, PaymentError } from '../commands/payments.js';
import { auditAfter } from '../commands/audit.js';
import { wakeOutbox } from '../events/outbox.js';

export const paymentsWebhookRouter = Router();
const ACTOR = 'system:mobile-money';

paymentsWebhookRouter.post('/payments/webhook', raw({ type: () => true, limit: '16kb' }), async (req, res, next) => {
  // Switched off unless the integration is live: in operator mode this endpoint doesn't exist.
  if (config.paymentConfirmation !== 'api') return res.status(404).json({ error: 'not found' });

  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const why = verifyWebhook({
    secret: config.paymentWebhookSecret,
    timestamp: req.get('X-GK-Timestamp'),
    signature: req.get('X-GK-Signature'),
    rawBody,
  });
  if (why) {
    console.warn(`[payments] webhook refused: ${why}`);
    return res.status(401).json({ error: 'unauthorized' });
  }

  let body;
  try { body = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'bad json' }); }
  const { orderId, reference, amount, payer } = body || {};
  const ref = normalizeReference(reference);
  if (!isUuid(orderId) || !ref || amount === undefined) {
    return res.status(400).json({ error: 'orderId, reference and amount are required' });
  }

  // A retry of a callback we already applied: say yes again, change nothing.
  const seen = await prisma.transaction.findUnique({ where: { telecom_receipt_id: ref }, select: { order_id: true } });
  if (seen && seen.order_id === orderId) return res.json({ ok: true, duplicate: true });

  try {
    const order = await confirmPayment({ orderId, reference: ref, amount, actor: ACTOR });
    wakeOutbox();
    return res.json({ ok: true, status: order.status });
  } catch (err) {
    if (!(err instanceof PaymentError)) return next(err);
    // Money arrived that we can't apply (wrong amount, unknown or already-paid order, reused
    // reference). Nobody may "fix" it by hand: it is logged for a refund, never forced through.
    auditAfter({
      actor: ACTOR, action: 'payment.unmatched', subject: `order:${orderId}`,
      detail: { reference: ref, amount: String(amount), payer: payer ? String(payer) : null, reason: err.message },
    });
    return res.status(err.status === 404 ? 404 : 409).json({ error: err.message });
  }
});
