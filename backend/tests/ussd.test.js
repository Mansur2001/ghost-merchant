// The wallet picker: one USSD tel: link per configured wallet. Invariant #5 still rules — the
// trailing '#' must stay %23-encoded or Android truncates the dial string and the payment
// silently never happens. The dial codes below are test fixtures, not real network codes.
import { describe, test, expect } from '@jest/globals';
import { parseWallets, buildWalletUri } from '../src/domain/wallets.js';
import { buildPaymentInstruction } from '../src/domain/ussd.js';

const EVC = { EVC_MERCHANT: '612345678', EVC_USSD: '*712*{NUM}*{AMT}%23' };
const EDAHAB = { EDAHAB_MERCHANT: '+252651234567', EDAHAB_USSD: '*110*{NUM}*{AMT}%23' };

describe('parseWallets', () => {
  test('nothing configured = nothing offered (no built-in codes or numbers)', () => {
    expect(parseWallets({})).toEqual({ wallets: [], errors: [], warnings: [] });
  });

  test('a configured wallet is offered with its national merchant number', () => {
    const { wallets, errors } = parseWallets({ ...EVC, ...EDAHAB });
    expect(errors).toEqual([]);
    expect(wallets.map((w) => w.id)).toEqual(['evc', 'edahab']);
    expect(wallets[1].merchant).toBe('651234567');
  });

  test('half-configured is an error, not a silent skip', () => {
    expect(parseWallets({ ZAAD_MERCHANT: '631234567' }).errors[0]).toMatch(/ZAAD_USSD/);
    expect(parseWallets({ SAHAL_USSD: '*883*{NUM}*{AMT}%23' }).errors[0]).toMatch(/SAHAL_MERCHANT/);
  });

  test('a placeholder or foreign merchant number is refused', () => {
    expect(parseWallets({ ...EVC, EVC_MERCHANT: '61XXXXXXX' }).errors).toHaveLength(1);
    expect(parseWallets({ ...EVC, EVC_MERCHANT: '+12065551234' }).errors).toHaveLength(1);
  });

  test.each([
    ['*712*{NUM}*{AMT}#', /bare #/],
    ['*712*{AMT}%23', /\{NUM\}/],
    ['*712*{NUM}%23', /\{AMT\}/],
    ['*712*{NUM}*{NUM}*{AMT}%23', /\{NUM\}/],
    ['712*{NUM}*{AMT}%23', /must look like/],
    ['*712*{NUM}*{AMT}', /must look like/],
    ['*712*{NUM} *{AMT}%23', /must look like/],
  ])('refuses the dial template %s', (template, why) => {
    expect(parseWallets({ ...EVC, EVC_USSD: template }).errors[0]).toMatch(why);
  });

  test('a merchant number on another network warns but still works', () => {
    const { wallets, warnings } = parseWallets({ ...EVC, EVC_MERCHANT: '651234567' });
    expect(wallets).toHaveLength(1);
    expect(warnings[0]).toMatch(/Hormuud/);
  });
});

describe('buildWalletUri', () => {
  const [evc] = parseWallets(EVC).wallets;

  test('injects merchant number + amount into the tel: URI', () => {
    expect(buildWalletUri(evc, 7.25)).toBe('tel:*712*612345678*7.25%23');
  });

  test('keeps the # pre-encoded as %23 — never a bare #', () => {
    const uri = buildWalletUri(evc, 5);
    expect(uri.endsWith('%23')).toBe(true);
    expect(uri).not.toMatch(/#/);
  });

  test('always formats the amount to 2 decimal places', () => {
    expect(buildWalletUri(evc, 5)).toContain('*5.00%23');
    expect(buildWalletUri(evc, '10')).toContain('*10.00%23');
    expect(buildWalletUri(evc, 3.1)).toContain('*3.10%23');
    expect(buildWalletUri(evc, 3.999)).toContain('*4.00%23'); // toFixed rounds
  });
});

describe('buildPaymentInstruction', () => {
  const { wallets } = parseWallets({ ...EVC, ...EDAHAB });

  test('a Somali customer gets one link per wallet, their own network first', () => {
    const p = buildPaymentInstruction({ user_phone: '+252651112223', total_amount: '4' }, wallets);
    expect(p.paymentMethod).toBe('ussd');
    expect(p.wallets.map((w) => w.id)).toEqual(['edahab', 'evc']);
    expect(p.wallets[0].ussdUri).toBe('tel:*110*651234567*4.00%23');
    expect(p.ussdUri).toBe(p.wallets[0].ussdUri); // older app builds read this
  });

  test('a US number gets no pay link at all', () => {
    const p = buildPaymentInstruction({ user_phone: '+12065551234', total_amount: '4' }, wallets);
    expect(p).toMatchObject({ paymentMethod: 'manual', wallets: [], ussdUri: null });
    expect(p.paymentNote).toMatch(/Somali numbers/);
  });

  test('no wallet configured = manual, never a fake number', () => {
    const p = buildPaymentInstruction({ user_phone: '+252612345678', total_amount: '4' }, []);
    expect(p).toMatchObject({ paymentMethod: 'manual', wallets: [], ussdUri: null });
  });
});
