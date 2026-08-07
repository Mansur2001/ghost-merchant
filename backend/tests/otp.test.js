// OTP primitives + session tokens. Pure crypto/domain — no DB, no HTTP.
import {
  generateCode,
  isWellFormedCode,
  hashCode,
  verifyCode,
  cooldownRemainingMs,
  OTP_LENGTH,
  RESEND_COOLDOWN_MS,
} from '../src/domain/otp.js';
import {
  signToken,
  verifyToken,
  CUSTOMER_TOKEN_TTL_SECONDS,
} from '../src/middleware/auth.js';

describe('generateCode', () => {
  test('is always exactly OTP_LENGTH digits, zero-padded', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateCode();
      expect(code).toMatch(new RegExp(`^\\d{${OTP_LENGTH}}$`));
    }
  });

  test('produces varied codes (not a constant)', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateCode()));
    expect(seen.size).toBeGreaterThan(150);
  });
});

describe('isWellFormedCode', () => {
  test('accepts only a 6-digit string', () => {
    expect(isWellFormedCode('004291')).toBe(true);
    expect(isWellFormedCode('12345')).toBe(false);
    expect(isWellFormedCode('1234567')).toBe(false);
    expect(isWellFormedCode('12a456')).toBe(false);
    expect(isWellFormedCode(123456)).toBe(false);
    expect(isWellFormedCode(null)).toBe(false);
    expect(isWellFormedCode('')).toBe(false);
  });
});

describe('hashCode / verifyCode', () => {
  test('round-trips the correct code', () => {
    const stored = hashCode('123456');
    expect(verifyCode('123456', stored)).toBe(true);
  });

  test('rejects a wrong code', () => {
    const stored = hashCode('123456');
    expect(verifyCode('123457', stored)).toBe(false);
    expect(verifyCode('', stored)).toBe(false);
  });

  test('salts so the same code hashes differently every time', () => {
    // Otherwise the table leaks which users share a code, and precomputation gets cheap.
    expect(hashCode('123456')).not.toBe(hashCode('123456'));
  });

  test('never stores the code in plaintext', () => {
    expect(hashCode('123456')).not.toContain('123456');
  });

  test('returns false rather than throwing on a malformed stored value', () => {
    expect(verifyCode('123456', 'garbage')).toBe(false);
    expect(verifyCode('123456', '')).toBe(false);
    expect(verifyCode('123456', null)).toBe(false);
    expect(verifyCode('123456', 'nothex:alsonothex')).toBe(false);
  });
});

describe('cooldownRemainingMs', () => {
  test('is zero when nothing was ever sent', () => {
    expect(cooldownRemainingMs(null)).toBe(0);
  });

  test('is the full window immediately after a send', () => {
    const now = Date.now();
    expect(cooldownRemainingMs(new Date(now), now)).toBe(RESEND_COOLDOWN_MS);
  });

  test('is zero once the window has elapsed', () => {
    const now = Date.now();
    expect(cooldownRemainingMs(new Date(now - RESEND_COOLDOWN_MS - 1), now)).toBe(0);
  });

  test('never goes negative', () => {
    const now = Date.now();
    expect(cooldownRemainingMs(new Date(now - 10 * RESEND_COOLDOWN_MS), now)).toBe(0);
  });
});

describe('session tokens', () => {
  test('round-trips a customer claim', () => {
    const token = signToken({ role: 'customer', phone: '+252612345678' });
    expect(verifyToken(token)).toMatchObject({ role: 'customer', phone: '+252612345678' });
  });

  test('rejects a tampered payload', () => {
    // The whole point: flipping your own phone claim must invalidate the signature.
    const token = signToken({ role: 'customer', phone: '+252612345678' });
    const [, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ role: 'operator', phone: '+252619999999', exp: 9e9 })
    ).toString('base64url');
    expect(verifyToken(`${forged}.${sig}`)).toBeNull();
  });

  test('rejects an expired token', () => {
    expect(verifyToken(signToken({ role: 'customer', phone: '+252612345678' }, -1))).toBeNull();
  });

  test('rejects garbage without throwing', () => {
    expect(verifyToken('')).toBeNull();
    expect(verifyToken(null)).toBeNull();
    expect(verifyToken('no-dot')).toBeNull();
    expect(verifyToken('.')).toBeNull();
    expect(verifyToken('!!!.!!!')).toBeNull();
    expect(verifyToken(`${Buffer.from('not json').toString('base64url')}.sig`)).toBeNull();
  });

  test('a token with no exp is rejected', () => {
    // Hand-rolled payloads must not get an unlimited session.
    const json = Buffer.from(JSON.stringify({ role: 'operator' })).toString('base64url');
    expect(verifyToken(`${json}.whatever`)).toBeNull();
  });

  test('customer sessions are long-lived by design', () => {
    expect(CUSTOMER_TOKEN_TTL_SECONDS).toBeGreaterThan(60 * 60 * 24 * 7);
  });
});
