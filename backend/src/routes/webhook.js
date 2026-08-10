// The Oracle link: signed payment webhook + heartbeat. Both are hit by the Android device.
//
// The Oracle is a SENSOR: it forwards messages that look like money arriving, from any rail
// the merchant phone can receive on. Deciding what a message MEANS happens here, on the
// server, so a reworded telecom receipt can be fixed with a deploy instead of a trip to the
// handset — see domain/receipts.js.
import { Router } from 'express';
import express from 'express';
import { rawBodySaver, verifyOracleSignature } from '../middleware/hmac.js';
import { recordAndMatchPayment } from '../commands/payments.js';
import { recordHeartbeat } from '../realtime/oracleMonitor.js';
import { parseReceipt } from '../domain/receipts.js';
import { claimPendingSms, confirmSms } from '../notify/smsQueue.js';

export const webhookRouter = Router();

// Raw-body JSON parser scoped to these routes so we can verify the HMAC over exact bytes.
const rawJson = express.json({ verify: rawBodySaver });

// POST /api/webhook — a message the Oracle thinks might be a payment.
//
// Two accepted shapes:
//   { senderId, body, receivedAt }                  — RAW forward (preferred)
//   { receiptId, senderMsisdn, amount, rawSms }     — pre-parsed, for older Oracle builds
//                                                     and the simulator
// The raw form is preferred because it keeps the phone dumb: it forwards, we interpret.
webhookRouter.post('/webhook', rawJson, verifyOracleSignature, async (req, res) => {
  try {
    const payload = req.body || {};
    let receipt;

    if (payload.body || payload.senderId) {
      receipt = parseReceipt({
        senderId: payload.senderId,
        body: payload.body,
        receivedAt: payload.receivedAt,
      });
      // Not a receipt — the merchant phone gets ordinary texts too. 200 with recognised:false
      // so the Oracle marks it seen and stops resending; a 4xx would make it retry forever.
      if (!receipt) {
        return res.json({ ok: true, recognised: false });
      }
    } else {
      const { receiptId, senderMsisdn, amount, rawSms } = payload;
      receipt = { receiptId, senderMsisdn, senderName: null, amount: Number(amount), rawSms };
    }

    const outcome = await recordAndMatchPayment(receipt);

    // Always 200 so the Oracle doesn't retry a receipt we've already stored.
    res.json({
      ok: true,
      recognised: true,
      provider: receipt.provider || null,
      duplicate: outcome.duplicate,
      matched: !!outcome.orderId,
      ambiguous: !!outcome.ambiguous,
      // A payment we can see but can't attribute goes to the operator's reconcile queue.
      // Telling the Oracle keeps the on-phone log honest about what actually happened.
      needsReconciliation: !outcome.duplicate && !outcome.orderId,
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

// ── Outbound SMS, collected by the phone ──
//
// The phone POLLS for messages to send rather than the backend calling it, because a phone
// cannot accept inbound connections behind carrier NAT. Both endpoints are HMAC-signed with
// the same shared secret as the webhook.
//
// POST because the signature is computed over a request BODY — a signed GET would need a
// different scheme for no benefit.

// POST /api/oracle/sms/pending — "anything for me to send?"
webhookRouter.post('/oracle/sms/pending', rawJson, verifyOracleSignature, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.body?.limit) || 5, 20);
    const messages = await claimPendingSms(limit);
    // The response carries live login codes, so it is never logged and never cached.
    res.set('Cache-Control', 'no-store');
    res.json({ messages });
  } catch (err) {
    next(err);
  }
});

// POST /api/oracle/sms/sent — "I sent it" (or "I couldn't").
// A confirmed message is DELETED, not marked sent: there is no reason to keep a plaintext
// login code once it has been delivered.
webhookRouter.post('/oracle/sms/sent', rawJson, verifyOracleSignature, async (req, res, next) => {
  try {
    const { id, ok, error } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const result = await confirmSms({ id, ok: ok !== false, error });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});
