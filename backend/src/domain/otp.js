// One-time passcode primitives. Pure domain logic — no DB, no Express, unit-testable.
//
// The threat model this is written against:
//   * Online guessing  -> 6 digits + MAX_ATTEMPTS + short TTL (see below).
//   * Offline cracking -> codes are scrypt-hashed at rest, so stealing the table does not
//                         hand over live logins.
//   * SMS spamming     -> RESEND_COOLDOWN_MS. Each send is a real SMS off the Oracle phone,
//                         so an uncapped resend loop is both a DoS and a direct cash cost.
//   * Biased codes     -> crypto.randomInt is uniform; never `Math.random() % 1e6`.
import crypto from 'node:crypto';

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 5 * 60 * 1000; // a code is dead 5 minutes after it is issued
export const MAX_ATTEMPTS = 5; // wrong guesses before the challenge is destroyed
export const RESEND_COOLDOWN_MS = 60 * 1000; // minimum gap between two sends to one number

// Uniformly random 6-digit code, zero-padded (so "004291" is a legal code, not "4291").
export function generateCode() {
  return String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

// Shape check only — never reveals whether a code is *correct*, just whether it's well-formed.
export function isWellFormedCode(code) {
  return typeof code === 'string' && new RegExp(`^\\d{${OTP_LENGTH}}$`).test(code);
}

export function hashCode(code) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(code), salt, 32);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

// Constant-time comparison; returns false rather than throwing on a malformed stored value.
export function verifyCode(code, stored) {
  if (typeof stored !== 'string') return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  let expected;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  const derived = crypto.scryptSync(String(code), Buffer.from(saltHex, 'hex'), 32);
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

// Milliseconds a caller must still wait before another send is allowed (0 = send now).
export function cooldownRemainingMs(lastSentAt, now = Date.now()) {
  if (!lastSentAt) return 0;
  const elapsed = now - new Date(lastSentAt).getTime();
  return Math.max(0, RESEND_COOLDOWN_MS - elapsed);
}
