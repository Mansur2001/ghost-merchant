// Invariant #5: the trailing '#' of the USSD string must stay %23-encoded or Android
// truncates the dial string and the payment silently never happens. env.js pins the
// template + merchant number so this is deterministic.
import { describe, test, expect } from '@jest/globals';
import { buildUssdUri } from '../src/domain/ussd.js';

describe('buildUssdUri', () => {
  test('injects merchant number + amount into the tel: URI', () => {
    expect(buildUssdUri(7.25)).toBe('tel:*712*612345678*7.25%23');
  });

  test('keeps the # pre-encoded as %23 — never a bare #', () => {
    const uri = buildUssdUri(5);
    expect(uri.endsWith('%23')).toBe(true);
    expect(uri).not.toMatch(/#/);
  });

  test('always formats the amount to 2 decimal places', () => {
    expect(buildUssdUri(5)).toContain('*5.00%23');
    expect(buildUssdUri('10')).toContain('*10.00%23');
    expect(buildUssdUri(3.1)).toContain('*3.10%23');
    expect(buildUssdUri(3.999)).toContain('*4.00%23'); // toFixed rounds
  });
});
