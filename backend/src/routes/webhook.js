// The Oracle link: signed payment webhook + heartbeat. Both are hit by the Android device.
import { Router } from 'express';
import express from 'express';
import { rawBodySaver, verifyOracleSignature } from '../middleware/hmac.js';
import { recordAndMatchPayment } from '../commands/payments.js';
import { recordHeartbeat } from '../realtime/oracleMonitor.js';

export const webhookRouter = Router();

// Raw-body JSON parser scoped to these routes so we can verify the HMAC over exact bytes.
const rawJson = express.json({ verify: rawBodySaver });

// POST /api/webhook  — parsed SMS receipt from the Oracle.
// Body: { receiptId, senderMsisdn, amount, rawSms }
webhookRouter.post('/webhook', rawJson, verifyOracleSignature, async (req, res) => {
  try {
    const { receiptId, senderMsisdn, amount, rawSms } = req.body || {};
    const outcome = await recordAndMatchPayment({
      receiptId,
      senderMsisdn,
      amount: Number(amount),
      rawSms,
    });
    // Always 200 so the Oracle doesn't retry a receipt we've already stored.
    res.json({
      ok: true,
      duplicate: outcome.duplicate,
      matched: !!outcome.orderId,
      ambiguous: !!outcome.ambiguous,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/heartbeat — liveness ping from the Oracle. Also HMAC-signed.
webhookRouter.post('/heartbeat', rawJson, verifyOracleSignature, (req, res) => {
  recordHeartbeat(req.body || {});
  res.json({ ok: true });
});
