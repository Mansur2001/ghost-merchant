// The customer wallet's money rules, with the database mocked:
//   * a balance never goes below zero, and never above the cap on a top-up;
//   * every change writes a ledger row with the balance it left;
//   * a top-up is credited only for the exact amount asked, once per gateway reference;
//   * the whole feature is off unless WALLET_ENABLED=true.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

let balance = 0n;
let usedRef = null;
const entries = [];
const tx = {
  $executeRaw: jest.fn(async (strings, ...vals) => {
    if (strings.join('?').includes('UPDATE wallet_accounts')) balance = BigInt(vals[0]);
    return 1;
  }),
  $queryRaw: jest.fn(async () => [{ balance_cents: balance }]),
  walletEntry: { create: jest.fn(async ({ data }) => { const e = { id: BigInt(entries.length + 1), ...data }; entries.push(e); return e; }) },
  walletAccount: { findUnique: jest.fn(async () => ({ balance_cents: balance })) },
  transaction: {
    findUnique: jest.fn(async () => usedRef),
    create: jest.fn(async ({ data }) => data),
  },
  paymentAttempt: {
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })),
    findFirst: jest.fn(async () => null),
    create: jest.fn(async ({ data }) => ({ status: 'pending', ...data })),
  },
  walletWithdrawal: { count: jest.fn(async () => 0), create: jest.fn(async ({ data }) => ({ id: 7n, status: 'requested', ...data })) },
  refund: { create: jest.fn(async ({ data }) => data) },
  order: { findUnique: jest.fn(async () => ({ status: 'PENDING_PAYMENT', total_amount: '3.00' })) },
};
jest.unstable_mockModule('../src/db/prisma.js', () => ({
  prisma: tx, withTransaction: async (fn) => fn(tx), withCriticalTransaction: async (fn) => fn(tx),
}));
const audit = jest.fn(async () => ({}));
jest.unstable_mockModule('../src/commands/audit.js', () => ({ audit, auditAfter: audit }));
jest.unstable_mockModule('../src/events/outbox.js', () => ({ enqueue: jest.fn(), wakeOutbox: jest.fn() }));
class PaymentError extends Error { constructor(m, s = 400) { super(m); this.status = s; } }
const confirmPayment = jest.fn(async ({ withinTx }) => { await withinTx(tx); return { status: 'PAID_UNASSIGNED' }; });
jest.unstable_mockModule('../src/commands/payments.js', () => ({ confirmPayment, PaymentError }));

const W = await import('../src/commands/wallet.js');
const { parseWaafiPay } = await import('../src/domain/waafipay.js');
const on = W.parseWalletSettings({ WALLET_ENABLED: 'true' });
const off = W.parseWalletSettings({});
const gateway = parseWaafiPay({ WAAFIPAY_MERCHANT_UID: 'M', WAAFIPAY_API_USER_ID: '1', WAAFIPAY_API_KEY: 'k' });

beforeEach(() => {
  balance = 0n; usedRef = null; entries.length = 0;
  [audit, confirmPayment, tx.transaction.create, tx.refund.create].forEach((f) => f.mockClear());
});

describe('settings', () => {
  test('off unless WALLET_ENABLED=true; sensible caps', () => {
    expect(off.enabled).toBe(false);
    expect(on).toMatchObject({ enabled: true, maxBalanceCents: 50000, topupMinCents: 100, topupMaxCents: 20000 });
  });
  test('every wallet action refuses while off', async () => {
    await expect(W.startTopup({ userId: 1, amount: 5, wallet: 'sahal', phone: '901234567', settings: off, gateway })).rejects.toThrow(/not available/);
    await expect(W.payOrderFromWallet({ orderId: 'o', userId: 1, settings: off })).rejects.toThrow(/not available/);
    await expect(W.requestWithdrawal({ userId: 1, amount: 5, phone: '901234567', settings: off })).rejects.toThrow(/not available/);
  });
});

describe('the ledger', () => {
  test('a credit and a debit each write a row with the balance after', async () => {
    await W.postEntry(tx, { userId: 1, amountCents: 1000, kind: 'topup', actor: 't' });
    await W.postEntry(tx, { userId: 1, amountCents: -300, kind: 'order_payment', actor: 't' });
    expect(entries.map((e) => [Number(e.amount_cents), Number(e.balance_after_cents)])).toEqual([[1000, 1000], [-300, 700]]);
    expect(balance).toBe(700n);
  });
  test('never below zero', async () => {
    balance = 200n;
    await expect(W.postEntry(tx, { userId: 1, amountCents: -300, kind: 'order_payment', actor: 't' })).rejects.toThrow(/not enough/);
    expect(balance).toBe(200n);
    expect(entries).toHaveLength(0);
  });
  test('a top-up can not push past the cap', async () => {
    balance = 49900n;
    await expect(W.postEntry(tx, { userId: 1, amountCents: 200, kind: 'topup', actor: 't', maxCents: 50000 })).rejects.toThrow(/at most/);
  });
});

describe('top-ups', () => {
  const attempt = { id: 'a1', user_id: 1, amount: '5.00', payer: '+252901234567' };
  test('amount outside the limits is refused before any prompt', async () => {
    await expect(W.startTopup({ userId: 1, amount: 0.5, wallet: 'sahal', phone: '901234567', settings: on, gateway })).rejects.toThrow(/between/);
    await expect(W.startTopup({ userId: 1, amount: 900, wallet: 'sahal', phone: '901234567', settings: on, gateway })).rejects.toThrow(/between/);
  });
  test('approved for the exact amount -> payment recorded and credited once', async () => {
    expect(await W.applyTopupOutcome(attempt, { status: 'approved', reference: '777', amount: '5.00' }, on)).toBe('approved');
    expect(tx.transaction.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ telecom_receipt_id: '777', order_id: null }) }));
    expect(balance).toBe(500n);
  });
  test('a reused reference credits nothing and is audited', async () => {
    usedRef = { order_id: 'x' };
    expect(await W.applyTopupOutcome(attempt, { status: 'approved', reference: '777', amount: '5.00' }, on)).toBe('unmatched');
    expect(balance).toBe(0n);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.unmatched' }));
  });
  test('a different amount than asked credits nothing', async () => {
    expect(await W.applyTopupOutcome(attempt, { status: 'approved', reference: '778', amount: '50.00' }, on)).toBe('unmatched');
    expect(balance).toBe(0n);
  });
});

describe('paying and refunding', () => {
  test('pay from the wallet goes through confirmPayment with the debit inside it', async () => {
    balance = 1000n;
    await W.payOrderFromWallet({ orderId: '9110aafa-fd8f-4469-8592-4d5f944952e3', userId: 1, settings: on });
    expect(confirmPayment).toHaveBeenCalledWith(expect.objectContaining({ provider: 'wallet', reference: expect.stringMatching(/^W\.[0-9A-F]{32}$/) }));
    expect(balance).toBe(700n);
  });
  test('not enough balance: refused, nothing taken', async () => {
    balance = 100n;
    await expect(W.payOrderFromWallet({ orderId: 'o', userId: 1, settings: on })).rejects.toThrow(/not enough/);
    expect(balance).toBe(100n);
  });
  test('a failed wallet-paid order credits the wallet and records the refund as settled', async () => {
    await W.refundToWallet(tx, { orderId: 'o', userId: 1, amountCents: 300, reason: 'no driver' });
    expect(balance).toBe(300n);
    expect(tx.refund.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'settled', settled_by: 'system:wallet' }) }));
  });
});

describe('withdrawals', () => {
  test('taken from the balance at request; a Somali number is required', async () => {
    balance = 1000n;
    await expect(W.requestWithdrawal({ userId: 1, amount: 5, phone: '+12065550100', settings: on })).rejects.toThrow(/Somali/);
    await W.requestWithdrawal({ userId: 1, amount: 5, phone: '901234567', settings: on });
    expect(balance).toBe(500n);
    expect(entries[0].kind).toBe('withdrawal');
  });
  test('more than the balance is refused', async () => {
    balance = 100n;
    await expect(W.requestWithdrawal({ userId: 1, amount: 5, phone: '901234567', settings: on })).rejects.toThrow(/not enough/);
  });
  test('marking paid needs the payout reference', async () => {
    await expect(W.markWithdrawalPaid({ id: '1', reference: ' ', actor: 'op' })).rejects.toThrow(/reference/);
  });
});
