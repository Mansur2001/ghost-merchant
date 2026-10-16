// Staff onboarding by invite: the admin never knows the secret, and the setup code is the
// only way in. These are the rules that make that hold.
import { describe, test, expect } from '@jest/globals';
import {
  generateSetupCode,
  isWellFormedSetupCode,
  unclaimableSecret,
  validateDriverPin,
  suggestUsername,
  setupMessage,
  SETUP_CODE_LENGTH,
} from '../src/domain/staffInvite.js';

describe('setup codes', () => {
  test('are always exactly SETUP_CODE_LENGTH digits, zero-padded, and varied', () => {
    const seen = new Set();
    for (let i = 0; i < 300; i += 1) {
      const c = generateSetupCode();
      expect(c).toMatch(new RegExp(`^\\d{${SETUP_CODE_LENGTH}}$`));
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(290);
  });

  test('shape check accepts only the exact form', () => {
    expect(isWellFormedSetupCode('01234567')).toBe(true);
    expect(isWellFormedSetupCode('1234567')).toBe(false);
    expect(isWellFormedSetupCode('1234567a')).toBe(false);
    expect(isWellFormedSetupCode(12345678)).toBe(false);
  });

  test('an unclaimed account holds a secret nobody could type', () => {
    expect(unclaimableSecret()).toMatch(/^[0-9a-f]{64}$/);
    expect(unclaimableSecret()).not.toBe(unclaimableSecret());
  });
});

describe('validateDriverPin', () => {
  test('accepts a six-digit PIN that is not an obvious pattern', () => {
    expect(validateDriverPin('482915')).toEqual({ valid: true, pin: '482915' });
  });

  test.each(['1234', '1234567', '12a456', ''])('rejects wrong shape: %s', (pin) => {
    expect(validateDriverPin(pin).valid).toBe(false);
  });

  test.each(['000000', '777777', '123456', '654321', '345678'])('rejects the PINs people try first: %s', (pin) => {
    expect(validateDriverPin(pin)).toEqual({ valid: false, reason: 'PIN is too easy to guess' });
  });
});

describe('suggestUsername', () => {
  test('turns a display name into a valid-looking username', () => {
    expect(suggestUsername('Amina Yusuf')).toBe('amina.yusuf');
    expect(suggestUsername("  Cabdi  Xasan-Nuur ")).toBe('cabdi.xasan.nuur');
  });
  test('gives up rather than suggest something too short', () => {
    expect(suggestUsername('Al')).toBe('');
  });
});

describe('setupMessage', () => {
  test('carries the code, the expiry and where to go — in both languages', () => {
    const m = setupMessage('driver', '12345678');
    expect(m.match(/12345678/g)).toHaveLength(2);
    expect(m).toMatch(/24h/);
    expect(m).toMatch(/Driver/);
    expect(m).toMatch(/Darawal/);
  });
  test('never includes anything but the code (no username, no link)', () => {
    expect(setupMessage('operator', '87654321')).not.toMatch(/http|username/i);
  });
});
