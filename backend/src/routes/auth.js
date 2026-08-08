// Customer authentication routes: prove you hold the phone number, get a session token.
//
// Layered defence on these two endpoints, because they are the front door and the only
// endpoints that spend money (each request can send a real SMS):
//   1. per-IP rate limit      - one host can't sweep many numbers
//   2. per-phone rate limit   - many hosts can't hammer one number (botnet / SMS-bomb)
//   3. per-phone DB cooldown  - atomic, survives a restart, enforced in commands/auth.js
//   4. per-challenge attempts - caps online guessing of the code itself
import { Router } from 'express';
import { requestOtp, verifyOtp, OtpCooldownError, OtpInvalidError } from '../commands/auth.js';
import { signToken, requireRole, CUSTOMER_TOKEN_TTL_SECONDS } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { isWellFormedCode } from '../domain/otp.js';
import { parsePhone } from '../domain/phone.js';
import { config } from '../config.js';

export const authRouter = Router();

// Bucket key for the per-phone limits. Falls back to the raw input so garbage can't dodge
// the limiter by simply being unparseable.
const phoneKey = (req) => {
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

// POST /api/auth/otp/request { phone }
authRouter.post('/auth/otp/request', ...requestLimits, async (req, res) => {
  try {
    const result = await requestOtp(req.body?.phone);
    const body = {
      sent: true,
      phone: result.phone,
      expiresInSeconds: result.expiresInSeconds,
    };
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
    // Invalid number (from normalizeMsisdnOrThrow) or SMS delivery failure.
    const status = /Invalid phone number/.test(err.message) ? 400 : 502;
    res.status(status).json({ error: status === 400 ? err.message : 'could not send code' });
  }
});

// POST /api/auth/otp/verify { phone, code } -> { token }
authRouter.post('/auth/otp/verify', ...verifyLimits, async (req, res) => {
  const { phone, code } = req.body || {};
  // Shape-check before touching the DB — but answer with the SAME generic error the real
  // verification uses, so "well-formed" isn't itself an information leak.
  if (!isWellFormedCode(String(code ?? ''))) {
    return res.status(401).json({ error: 'invalid or expired code' });
  }
  try {
    const { phone: verified } = await verifyOtp(phone, code);
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
authRouter.get('/auth/me', requireRole('customer'), (req, res) => {
  res.json({ phone: req.auth.phone, role: req.auth.role, exp: req.auth.exp });
});
