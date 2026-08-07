// HMAC verification for the Android Oracle webhook. The /webhook endpoint is on the
// public internet; without this, anyone who finds the URL could POST fake "payment
// received" events and get free groceries. The Oracle signs the raw body with a shared
// secret; we recompute and compare in constant time.
import crypto from 'node:crypto';
import { config } from '../config.js';

// Express needs the RAW body to verify the signature, so mount this as the body parser
// for the webhook route (see routes/webhook.js). It stashes the raw buffer on req.
export function rawBodySaver(req, res, buf) {
  req.rawBody = buf;
}

export function verifyOracleSignature(req, res, next) {
  const signature = req.get('X-Oracle-Signature') || '';
  const raw = req.rawBody || Buffer.from('');
  const expected = crypto
    .createHmac('sha256', config.oracleWebhookSecret)
    .update(raw)
    .digest('hex');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'invalid signature' });
  }
  next();
}
