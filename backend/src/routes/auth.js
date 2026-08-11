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
import {
  startCallChallenge,
  pollCallChallenge,
  isCallVerificationConfigured,
  callVerificationNumber,
  CallChallengeInvalidError,
  CallVerificationUnavailableError,
} from '../commands/callAuth.js';
import { isWellFormedTicket, CALL_POLL_INTERVAL_MS } from '../domain/callChallenge.js';
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

// ── Missed-call verification ──
//
// The other way to prove possession of a number, and the preferred one for +252: the customer
// calls a number we own and hangs up, and the caller ID is the proof. Nothing is sent, so
// none of the SMS failure modes exist here — no A2P agreement, no per-message cost, no queue
// to stall, and no code that a caller claiming to be support can ask a customer to read out.
//
// Rate limits are lighter than the passcode ones on purpose: those protect real money and SIM
// quota, while opening a challenge here costs nothing. They exist to stop a client spinning
// the endpoint, not to protect a budget.
const callStartLimits = [
  rateLimit({ windowMs: HOUR, max: 60, message: 'too many verification attempts' }),
  rateLimit({ windowMs: HOUR, max: 15, key: phoneKey, message: 'too many verification attempts' }),
];

// Polling is a normal part of this flow — the client asks every couple of seconds while the
// customer dials — so the ceiling has to accommodate a legitimate wait without being open.
const callPollLimits = [
  rateLimit({ windowMs: 15 * 60 * 1000, max: 400, message: 'too many attempts' }),
  rateLimit({ windowMs: 15 * 60 * 1000, max: 200, key: phoneKey, message: 'too many attempts' }),
];

// GET /api/auth/methods — what this deployment can actually do.
// The client must not hardcode "Somali numbers call, everyone else texts": whether a
// call-capable device exists is deployment configuration, and a PWA that assumes it does
// shows a dead button on a deployment without one.
authRouter.get('/auth/methods', (req, res) => {
  res.json({
    call: isCallVerificationConfigured(),
    sms: true,
    callNumber: isCallVerificationConfigured() ? callVerificationNumber() : null,
  });
});

// POST /api/auth/call/start { phone } -> { callNumber, ticket, expiresInSeconds }
//
// The ticket is the client's claim on this challenge and the only thing that can redeem it.
// It is returned once, held in memory by the client, and never displayed to the customer.
authRouter.post('/auth/call/start', ...callStartLimits, async (req, res) => {
  try {
    const result = await startCallChallenge(req.body?.phone);
    // The body carries a live credential: never cached, never in an intermediary.
    res.set('Cache-Control', 'no-store');
    res.json({ ...result, pollIntervalMs: CALL_POLL_INTERVAL_MS });
  } catch (err) {
    if (err instanceof CallVerificationUnavailableError) {
      return res.status(503).json({ error: err.message });
    }
    if (err.status === 429) {
      const retryAfter = Math.ceil((err.retryAfterMs || 5000) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: err.message, retryAfter });
    }
    if (/Invalid phone number/.test(err.message)) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'could not start verification' });
  }
});

// POST /api/auth/call/status { phone, ticket } -> { status } | { status, token }
// The client polls this while the customer dials.
authRouter.post('/auth/call/status', ...callPollLimits, async (req, res) => {
  const { phone, ticket } = req.body || {};
  // Shape-check before spending a scrypt, but answer with the SAME generic error real
  // verification uses — "well-formed" must not itself be a signal.
  if (!isWellFormedTicket(String(ticket ?? ''))) {
    return res.status(401).json({ error: 'invalid or expired verification' });
  }
  try {
    const result = await pollCallChallenge(phone, ticket);
    res.set('Cache-Control', 'no-store');
    if (result.status !== 'verified') {
      return res.json({ status: 'pending', pollIntervalMs: CALL_POLL_INTERVAL_MS });
    }
    const token = signToken({ role: 'customer', phone: result.phone }, CUSTOMER_TOKEN_TTL_SECONDS);
    res.json({
      status: 'verified',
      token,
      phone: result.phone,
      expiresInSeconds: CUSTOMER_TOKEN_TTL_SECONDS,
    });
  } catch (err) {
    if (err instanceof CallChallengeInvalidError) return res.status(401).json({ error: err.message });
    if (/Invalid phone number/.test(err.message)) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: 'verification failed' });
  }
});
