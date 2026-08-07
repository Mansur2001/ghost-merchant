// Lightweight stateless auth. Sessions are HMAC-signed tokens (no external dependency).
// Operator = single super-user password. Driver = per-driver PIN (scrypt-hashed in DB).
import crypto from 'node:crypto';
import { config } from '../config.js';

// ── PIN / password hashing (scrypt) ──────────────────────
export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(secret, salt, 32);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifySecret(secret, stored) {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const derived = crypto.scryptSync(secret, Buffer.from(saltHex, 'hex'), 32);
  const a = Buffer.from(hashHex, 'hex');
  return a.length === derived.length && crypto.timingSafeEqual(a, derived);
}

// ── Signed session tokens ────────────────────────────────
// Staff sessions are short (a shared dispatch terminal shouldn't stay logged in overnight).
// Customer sessions are long: re-verifying by SMS costs real money and the customer is on
// one personal handset, so the trade is deliberate.
export const STAFF_TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12 hours
export const CUSTOMER_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export function signToken(payload, ttlSeconds = STAFF_TOKEN_TTL_SECONDS) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const json = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(json)
    .digest('base64url');
  return `${json}.${sig}`;
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [json, sig] = token.split('.');
  if (!json || !sig) return null;
  const expected = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(json)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  // A signature match means we minted this, but the payload can still be garbage if the
  // secret ever leaked or a test hand-rolled one — never let a parse error become a 500.
  let payload;
  try {
    payload = JSON.parse(Buffer.from(json, 'base64url').toString());
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// Pull a bearer token off a request without asserting anything about it.
export function tokenFromRequest(req) {
  return (req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
}

// Express guard: require a valid token with one of the allowed roles.
export function requireRole(...roles) {
  return (req, res, next) => {
    const payload = verifyToken(tokenFromRequest(req));
    if (!payload || !roles.includes(payload.role)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.auth = payload;
    next();
  };
}

// Express guard: require *any* valid session. Used on order-scoped routes, where the
// role-specific decision is made afterwards by requireOrderAccess.
export const requireAuth = requireRole('customer', 'driver', 'operator');
