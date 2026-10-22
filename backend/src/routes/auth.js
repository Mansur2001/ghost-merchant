// Customer authentication routes: prove you hold the phone number, get a session token.
//
// Layered defence on these two endpoints, because they are the front door and the only
// endpoints that spend money (each request can send a real SMS):
//   1. per-IP rate limit      - one host can't sweep many numbers
//   2. per-phone rate limit   - many hosts can't hammer one number (botnet / SMS-bomb)
//   3. per-phone DB cooldown  - atomic, survives a restart, enforced in commands/auth.js
//   4. per-challenge attempts - caps online guessing of the code itself
import { Router } from 'express';
import {
  requestOtp, verifyOtp, requestOtpByEmail, verifyOtpByEmail, OtpCooldownError, OtpInvalidError, AuthInputError, emailAvailable,
  requestEmailLink, verifyEmailLink, removeEmail, getCustomerEmail,
} from '../commands/auth.js';
import { signToken, requireRole, CUSTOMER_TOKEN_TTL_SECONDS } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { isWellFormedCode } from '../domain/otp.js';
import { parsePhone } from '../domain/phone.js';
import { config } from '../config.js';

export const authRouter = Router();

// Bucket key for the per-phone limits. Falls back to the raw input so garbage can't dodge
// the limiter by simply being unparseable.
// Signing in by email buckets by the email instead.
const phoneKey = (req) => {
  if (req.body?.channel === 'email' || (req.body?.email && !req.body?.phone)) {
    return `email:${String(req.body?.email || '').trim().toLowerCase().slice(0, 254)}`;
  }
  const parsed = parsePhone(req.body?.phone);
  return parsed.valid ? parsed.e164 : `raw:${String(req.body?.phone || '').slice(0, 24)}`;
};

const HOUR = 60 * 60 * 1000;

const requestLimits = [
  rateLimit({ windowMs: HOUR, max: 20, message: 'too many code requests' }),
  rateLimit({ windowMs: HOUR, max: 5, key: phoneKey, message: 'too many code requests' }),
];

const verifyLimits = [
  rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: 'too many attempts' }),
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: phoneKey, message: 'too many attempts' }),
];

// GET /api/auth/channels — whether the sign-in screen should offer "Email me a code".
// Server-wide only: it says nothing about any particular number.
authRouter.get('/auth/channels', (req, res) => {
  res.json({ sms: true, email: emailAvailable() });
});

// POST /api/auth/otp/request { phone }  or  { channel: 'email', email }
// By email the answer never includes the phone: it would tell anyone whose number an email is.
authRouter.post('/auth/otp/request', ...requestLimits, async (req, res) => {
  try {
    const channel = req.body?.channel || 'sms';
    if (channel !== 'sms' && channel !== 'email') throw new AuthInputError('channel must be sms or email');
    const result = channel === 'email'
      ? await requestOtpByEmail(req.body?.email)
      : await requestOtp(req.body?.phone);
    const body = { sent: true, expiresInSeconds: result.expiresInSeconds };
    if (channel === 'sms') body.phone = result.phone;
    // DEV ONLY: with the log transport there is no SMS, so the flow would be untestable
    // without echoing the code. Hard-gated on BOTH the transport and NODE_ENV so no
    // production configuration can reach it.
    if (result.transport === 'log' && config.env !== 'production') {
      body.devCode = result.code;
    }
    res.json(body);
  } catch (err) {
    if (err instanceof OtpCooldownError) {
      const retryAfter = Math.ceil(err.retryAfterMs / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: err.message, retryAfter });
    }
    if (err instanceof AuthInputError) return res.status(400).json({ error: err.message });
    // Invalid number (from normalizeMsisdnOrThrow) or SMS / email delivery failure.
    const status = /Invalid phone number/.test(err.message) ? 400 : 502;
    // The customer gets a generic message, but the REASON has to reach the log or a delivery
    // failure is indistinguishable from every other cause of "no code arrived" — which is the
    // single most expensive thing to debug in this system. Never the code itself, only why.
    if (status === 502) console.error(`[OTP] delivery failed: ${err.message}`);
    if (status === 400) return res.status(400).json({ error: err.message });
    res.status(502).json({ error: 'could not send code', cause: err.failure || 'SEND' });
  }
});

// POST /api/auth/otp/verify { phone, code } or { email, code } -> { token }
authRouter.post('/auth/otp/verify', ...verifyLimits, async (req, res) => {
  const { phone, email, code } = req.body || {};
  // Shape-check before touching the DB — but answer with the SAME generic error the real
  // verification uses, so "well-formed" isn't itself an information leak.
  if (!isWellFormedCode(String(code ?? ''))) {
    return res.status(401).json({ error: 'invalid or expired code' });
  }
  try {
    const { phone: verified } = email && !phone
      ? await verifyOtpByEmail(email, code)
      : await verifyOtp(phone, code);
    const token = signToken({ role: 'customer', phone: verified }, CUSTOMER_TOKEN_TTL_SECONDS);
    res.json({ token, phone: verified, expiresInSeconds: CUSTOMER_TOKEN_TTL_SECONDS });
  } catch (err) {
    if (err instanceof OtpInvalidError) return res.status(401).json({ error: err.message });
    if (/Invalid phone number/.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'verification failed' });
  }
});

// GET /api/auth/me — lets a client confirm a stored token is still valid on boot.
authRouter.get('/auth/me', requireRole('customer'), async (req, res, next) => {
  try {
    const email = await getCustomerEmail(req.auth.phone);
    res.json({ phone: req.auth.phone, role: req.auth.role, exp: req.auth.exp, email });
  } catch (err) {
    next(err);
  }
});

// ── Email for sign-in codes (signed-in customers only) ──
// The session proves the phone; the code proves the email. The phone comes from the token,
// never the body, so nobody can attach an email to someone else's number.
const linkLimits = [
  rateLimit({ windowMs: HOUR, max: 20, message: 'too many code requests' }),
  rateLimit({ windowMs: HOUR, max: 5, key: (req) => req.auth.phone, message: 'too many code requests' }),
];

// POST /api/auth/email/request { email }
authRouter.post('/auth/email/request', requireRole('customer'), ...linkLimits, async (req, res) => {
  try {
    const result = await requestEmailLink(req.auth.phone, req.body?.email);
    const body = { sent: true, email: result.email, expiresInSeconds: result.expiresInSeconds };
    if (result.transport === 'log' && config.env !== 'production') body.devCode = result.code;
    res.json(body);
  } catch (err) {
    if (err instanceof OtpCooldownError) {
      const retryAfter = Math.ceil(err.retryAfterMs / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: err.message, retryAfter });
    }
    if (err instanceof AuthInputError) return res.status(400).json({ error: err.message });
    res.status(502).json({ error: 'could not send code', cause: err.failure || 'SEND' });
  }
});

// POST /api/auth/email/verify { code } -> { email }
authRouter.post(
  '/auth/email/verify',
  requireRole('customer'),
  rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: (req) => req.auth.phone, message: 'too many attempts' }),
  async (req, res, next) => {
    // 400, not 401: the session is fine — a 401 would make the app sign the customer out.
    const code = String(req.body?.code ?? '');
    if (!isWellFormedCode(code)) return res.status(400).json({ error: 'invalid or expired code' });
    try {
      res.json(await verifyEmailLink(req.auth.phone, code));
    } catch (err) {
      if (err instanceof OtpInvalidError) return res.status(400).json({ error: err.message });
      next(err);
    }
  }
);

// DELETE /api/auth/email — stop sending codes to email; SMS only again.
authRouter.delete('/auth/email', requireRole('customer'), async (req, res, next) => {
  try {
    await removeEmail(req.auth.phone);
    res.json({ email: null });
  } catch (err) {
    next(err);
  }
});
