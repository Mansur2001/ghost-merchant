// The browser mirror (frontend/shared/phone.js) and the enforced backend rule
// (backend/src/domain/phone.js) must agree.
//
// If they drift, the UI accepts a number the API then rejects — which the customer
// experiences as "the app is broken", and which nobody notices in review because the two
// files are edited months apart. This test loads the real browser file into a fake `window`
// and diffs the two implementations over a corpus of inputs.
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parsePhone } from '../src/domain/phone.js';

const here = dirname(fileURLToPath(import.meta.url));
const browserSrc = readFileSync(join(here, '../../frontend/shared/phone.js'), 'utf8');

// Execute the classic script exactly as a browser would, with a stub global.
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(browserSrc, sandbox);
const SomPhone = sandbox.window.SomPhone;

const CORPUS = [
  // Somali — every accepted input form
  '612345678', '0612345678', '+252612345678', '00252612345678',
  '61 234 5678', '61-234-5678', '+252 61 234 5678',
  '621234567', '651234567', '661234567', '631234567', '641234567',
  '671234567', '681234567', '691234567', '711234567', '771234567', '901234567',
  // Somali — invalid
  '', '991234567', '601234567', '6123456', '6123456789', '61234567890',
  'hello', '+252', '0', '00252',
  // US — valid, explicit country code required
  '+12065551234', '12065551234', '001 206 555 1234', '+1 (206) 555-1234', '1-206-555-1234',
  '+14155552671', '+19175551234',
  // US — invalid
  '+11065551234', '+11165551234', '+12060551234', '+12061551234',
  '2065551234', '206-555-1234', '(206) 555-1234',
  // Nonsense / adversarial
  '++++', '     ', '+++1234567890', '99999999999999999999', '+252612345678612345678',
];

describe('backend and browser phone rules agree', () => {
  test.each(CORPUS)('validity matches for %p', (input) => {
    const back = parsePhone(input);
    const front = SomPhone.parse(input);
    expect(Boolean(front.valid)).toBe(Boolean(back.valid));
  });

  test.each(CORPUS.filter((v) => parsePhone(v).valid))('E.164 matches for %p', (input) => {
    expect(SomPhone.parse(input).e164).toBe(parsePhone(input).e164);
  });

  test.each(CORPUS.filter((v) => parsePhone(v).valid))('USSD capability matches for %p', (input) => {
    // If these disagree, the UI either shows a dead pay button or hides a working one.
    expect(Boolean(SomPhone.parse(input).canUssd)).toBe(Boolean(parsePhone(input).canUssd));
  });

  test('the operator prefix tables are identical', () => {
    // Drift here means the UI names a different carrier than the backend recorded.
    const front = SomPhone.PREFIX_TO_OPERATOR;
    // eslint-disable-next-line no-undef
    return import('../src/domain/phone.js').then(({ PREFIX_TO_OPERATOR }) => {
      expect(front).toEqual(PREFIX_TO_OPERATOR);
    });
  });

  test('neither side accepts a bare 10-digit US number', () => {
    // The asymmetry that protects Somali typos has to hold on BOTH sides, or the UI would
    // encourage input the API rejects.
    expect(parsePhone('2065551234').valid).toBe(false);
    expect(SomPhone.parse('2065551234').valid).toBe(false);
  });
});
