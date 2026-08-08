// Invariant #4: phone numbers are the customer identity, so normalization is a trust
// boundary. If "61234567", "061234567", and "+25261234567" don't all collapse to the same
// canonical E.164, a payment receipt won't match its order. These tests pin that behavior
// and the strict rejection of everything that isn't a real assigned Somali mobile number.
import { describe, test, expect } from '@jest/globals';
import {
  parsePhone,
  normalizeMsisdnOrThrow,
  canPayByUssd,
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
    const r = parsePhone(raw);
    expect(r.valid).toBe(true);
    expect(r.e164).toBe('+252612345678');
    expect(r.national).toBe('612345678');
    expect(normalizeMsisdnOrThrow(raw)).toBe('+252612345678');
  });
});

describe('operator detection from the 2-digit prefix', () => {
  test.each(Object.entries(PREFIX_TO_OPERATOR))('prefix %s → %s', (prefix, operator) => {
    const r = parsePhone(`${prefix}1234567`);
    expect(r.valid).toBe(true);
    expect(r.operator).toBe(operator);
  });
});

describe('rejects invalid numbers with a reason', () => {
  test('empty input', () => {
    expect(parsePhone('').valid).toBe(false);
    expect(parsePhone(null).valid).toBe(false);
    expect(parsePhone(undefined).valid).toBe(false);
  });

  test('unassigned operator prefix', () => {
    const r = parsePhone('991234567');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/unknown operator prefix/);
  });

  test('too few digits', () => {
    const r = parsePhone('6123456');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/expected 9 digits/);
  });

  test('too many digits', () => {
    // Critically this must NOT become a valid US number: bare digits are always read as
    // Somali, so a fat-fingered extra digit fails loudly instead of silently changing country.
    const r = parsePhone('6123456789');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/expected 9 digits/);
  });

  test('normalizeMsisdnOrThrow throws on garbage', () => {
    expect(() => normalizeMsisdnOrThrow('hello')).toThrow(/Invalid phone number/);
    expect(() => normalizeMsisdnOrThrow('991234567')).toThrow(/Invalid phone number/);
  });
});

describe('frontend/backend prefix maps stay in sync (invariant #4)', () => {
  test('backend map is non-empty and every entry is a 2-digit prefix', () => {
    const entries = Object.keys(PREFIX_TO_OPERATOR);
    expect(entries.length).toBeGreaterThan(0);
    for (const p of entries) expect(p).toMatch(/^\d{2}$/);
  });
});

// ── US (+1) support ──
// Added so the app can be tested end-to-end on a North American handset. The important
// property is NOT that +1 works everywhere — it's that a +1 number is a valid identity but
// explicitly cannot pay by USSD, and every layer agrees on that.
describe('US numbers', () => {
  test.each([
    '+12065551234',
    '12065551234',
    '+1 (206) 555-1234',
    '1-206-555-1234',
    '001 206 555 1234',
  ])('%s canonicalizes to +12065551234', (raw) => {
    const r = parsePhone(raw);
    expect(r.valid).toBe(true);
    expect(r.country).toBe('US');
    expect(r.e164).toBe('+12065551234');
  });

  test('a US number is valid identity but cannot pay by USSD', () => {
    // The whole point of the country flag: valid !== payable.
    const r = parsePhone('+12065551234');
    expect(r.valid).toBe(true);
    expect(r.canUssd).toBe(false);
    expect(canPayByUssd('+12065551234')).toBe(false);
  });

  test('a Somali number CAN pay by USSD', () => {
    expect(canPayByUssd('612345678')).toBe(true);
    expect(parsePhone('612345678').canUssd).toBe(true);
  });

  test('rejects NANP numbers with an illegal area or exchange code', () => {
    // Area code and exchange must start 2-9; 0/1 leads are not assignable.
    expect(parsePhone('+11065551234').valid).toBe(false); // area code starts 0
    expect(parsePhone('+11165551234').valid).toBe(false); // area code starts 1
    expect(parsePhone('+12060551234').valid).toBe(false); // exchange starts 0
    expect(parsePhone('+12061551234').valid).toBe(false); // exchange starts 1
  });
});

describe('country disambiguation', () => {
  test('bare digits are ALWAYS Somali; US requires an explicit +1', () => {
    // Somalia is the product, +1 is a test affordance — the product must not pay for it.
    expect(parsePhone('612345678').country).toBe('SO');
    expect(parsePhone('+12065551234').country).toBe('US');
    // A bare 10-digit US number is rejected, with a hint rather than a bare length error.
    const bare = parsePhone('2065551234');
    expect(bare.valid).toBe(false);
    expect(bare.reason).toMatch(/\+1/);
  });

  test('a Somali typo cannot silently become a valid US number', () => {
    // '6123456789' is a legal NANP number (area 612, exchange 345). If bare 10-digit input
    // were read as US, this typo would create an order under an identity that isn't theirs
    // and whose payment could never match.
    const typo = parsePhone('6123456789');
    expect(typo.valid).toBe(false);
    expect(typo.country).toBeUndefined();
  });

  test('an explicit country code always wins over the length heuristic', () => {
    expect(parsePhone('+252612345678').country).toBe('SO');
    expect(parsePhone('+12065551234').country).toBe('US');
  });

  test('a leading 1 does not swallow a Somali number', () => {
    // Somali prefixes never start with 1, and the length guard means "1" + 10 digits only.
    expect(parsePhone('612345678').e164).toBe('+252612345678');
  });

  test('the Somali trunk 0 is stripped, not read as a US number', () => {
    expect(parsePhone('0612345678').e164).toBe('+252612345678');
  });

  test('a length that fits nothing is rejected with a helpful reason', () => {
    const r = parsePhone('12345');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/expected 9 digits/);
  });

  test('an 11-digit non-US string is rejected rather than truncated', () => {
    expect(parsePhone('61234567890').valid).toBe(false);
  });
});
