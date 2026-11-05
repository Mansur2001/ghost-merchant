// The contract a mobile-money integration (Sahal, EVC Plus, a gateway) uses to tell us an order
// is paid. Pure: signing and checking only. docs/PAYMENT_API.md is the integrator's guide.
//
//   POST /api/payments/webhook
//   X-GK-Timestamp: <unix seconds>
//   X-GK-Signature: hex(HMAC-SHA256(PAYMENT_WEBHOOK_SECRET, "<timestamp>.<raw body>"))
//   { "orderId": "<uuid>", "reference": "<telecom transaction id>", "amount": "7.50", "payer": "+2526…" }
//
// The timestamp is inside the signature and must be within 5 minutes, so a captured callback
// can't be replayed later; the reference is UNIQUE, so a replay inside the window is a no-op.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_SKEW_SECONDS = 300;

export function signPayload(secret, timestamp, rawBody) {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

// null when good, otherwise why not (for the log, never for the caller).
export function verifyWebhook({ secret, timestamp, signature, rawBody, now = Date.now() }) {
  if (!secret) return 'webhook not configured';
  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) return 'missing timestamp';
  if (Math.abs(now / 1000 - ts) > MAX_SKEW_SECONDS) return 'timestamp outside the 5-minute window';
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return 'missing signature';
  const expected = Buffer.from(signPayload(secret, ts, rawBody), 'hex');
  const given = Buffer.from(signature, 'hex');
  return timingSafeEqual(expected, given) ? null : 'bad signature';
}
