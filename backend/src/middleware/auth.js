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
export function signToken(payload, ttlSeconds = 60 * 60 * 12) {
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
  const expected = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(json)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(Buffer.from(json, 'base64url').toString());
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// Express guard: require a valid token with one of the allowed roles.
export function requireRole(...roles) {
  return (req, res, next) => {
    const token = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const payload = verifyToken(token);
    if (!payload || !roles.includes(payload.role)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.auth = payload;
    next();
  };
}
