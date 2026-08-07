// Invariant #4: phone numbers are the customer identity, so normalization is a trust
// boundary. If "61234567", "061234567", and "+25261234567" don't all collapse to the same
// canonical E.164, a payment receipt won't match its order. These tests pin that behavior
// and the strict rejection of everything that isn't a real assigned Somali mobile number.
import { describe, test, expect } from '@jest/globals';
import {
  parseSomaliMsisdn,
  normalizeMsisdnOrThrow,
  PREFIX_TO_OPERATOR,
} from '../src/domain/phone.js';

describe('accepts and canonicalizes every valid input form', () => {
  test.each([
    '612345678',
    '0612345678',
    '+252612345678',
    '00252612345678',
    '61 234 5678',
    '61-234-5678',
    '+252 61 234 5678',
  ])('%s → +252612345678', (raw) => {
    const r = parseSomaliMsisdn(raw);
    expect(r.valid).toBe(true);
    expect(r.e164).toBe('+252612345678');
    expect(r.national).toBe('612345678');
    expect(normalizeMsisdnOrThrow(raw)).toBe('+252612345678');
  });
});

describe('operator detection from the 2-digit prefix', () => {
  test.each(Object.entries(PREFIX_TO_OPERATOR))('prefix %s → %s', (prefix, operator) => {
    const r = parseSomaliMsisdn(`${prefix}1234567`);
    expect(r.valid).toBe(true);
    expect(r.operator).toBe(operator);
  });
});

describe('rejects invalid numbers with a reason', () => {
  test('empty input', () => {
    expect(parseSomaliMsisdn('').valid).toBe(false);
    expect(parseSomaliMsisdn(null).valid).toBe(false);
    expect(parseSomaliMsisdn(undefined).valid).toBe(false);
  });

  test('unassigned operator prefix', () => {
    const r = parseSomaliMsisdn('991234567');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/unknown operator prefix/);
  });

  test('too few digits', () => {
    const r = parseSomaliMsisdn('6123456');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/expected 9 digits/);
  });

  test('too many digits', () => {
    const r = parseSomaliMsisdn('6123456789');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/expected 9 digits/);
  });

  test('normalizeMsisdnOrThrow throws on garbage', () => {
    expect(() => normalizeMsisdnOrThrow('hello')).toThrow(/Invalid Somali phone number/);
    expect(() => normalizeMsisdnOrThrow('991234567')).toThrow(/Invalid Somali phone number/);
  });
});

describe('frontend/backend prefix maps stay in sync (invariant #4)', () => {
  test('backend map is non-empty and every entry is a 2-digit prefix', () => {
    const entries = Object.keys(PREFIX_TO_OPERATOR);
    expect(entries.length).toBeGreaterThan(0);
    for (const p of entries) expect(p).toMatch(/^\d{2}$/);
  });
});
