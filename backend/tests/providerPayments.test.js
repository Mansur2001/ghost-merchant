// In-app wallet payments (WaafiPay). The rules that keep a gateway from costing anyone money:
//   * one prompt at a time per order — a double tap never charges twice;
//   * only APPROVED with a transaction id confirms, through confirmPayment (same rules as an
//     operator: amount to the cent, reference UNIQUE);
//   * an answer we can't read is 'unknown', blocks a new prompt for a while, and is never
//     treated as declined (the customer may have been charged);
//   * money we can't apply is audited as payment.unmatched, never forced through.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const ORDER = '9110aafa-fd8f-4469-8592-4d5f944952e3';
let orderRow;
let pendingAttempt;
let unknownAttempt;
const attempts = [];

const tx = {
  $queryRaw: jest.fn(async () => (orderRow ? [orderRow] : [])),
  paymentAttempt: {
    findFirst: jest.fn(async ({ where }) => (where.status === 'pending' ? pendingAttempt : unknownAttempt)),
    create: jest.fn(async ({ data }) => { const a = { status: 'pending', ...data }; attempts.push(a); return a; }),
    update: jest.fn(async ({ data, where }) => ({ ...attempts.find((a) => a.id === where.id), ...data })),
    updateMany: jest.fn(async () => ({ count: 1 })),
    findUnique: jest.fn(async ({ where }) => ({ ...attempts.find((a) => a.id === where.id), status: 'declined' })),
    findMany: jest.fn(async () => []),
  },
};

jest.unstable_mockModule('../src/db/prisma.js', () => ({
  prisma: tx,
  withTransaction: async (fn) => fn(tx),
  withCriticalTransaction: async (fn) => fn(tx),
}));
const enqueue = jest.fn();
const wakeOutbox = jest.fn();
jest.unstable_mockModule('../src/events/outbox.js', () => ({ enqueue, wakeOutbox }));
jest.unstable_mockModule('../src/events/bus.js', () => ({ EVENTS: { PAYMENT_ATTEMPT: 'payment.attempt' } }));
const postMessage = jest.fn(async () => ({}));
jest.unstable_mockModule('../src/commands/orders.js', () => ({ postMessage }));
const auditAfter = jest.fn();
jest.unstable_mockModule('../src/commands/audit.js', () => ({ auditAfter, audit: jest.fn() }));

class PaymentError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const confirmPayment = jest.fn(async ({ withinTx }) => { await withinTx(tx); return { status: 'PAID_UNASSIGNED' }; });
jest.unstable_mockModule('../src/commands/payments.js', () => ({ confirmPayment, PaymentError }));

const { startWalletPayment, applyOutcome, settleWalletPayment } = await import('../src/commands/providerPayments.js');
const { parseWaafiPay } = await import('../src/domain/waafipay.js');

const settings = parseWaafiPay({ WAAFIPAY_MERCHANT_UID: 'M1', WAAFIPAY_API_USER_ID: '100', WAAFIPAY_API_KEY: 'k', WAAFIPAY_URL: 'http://mock/asm' });
const approved = async () => ({ status: 200, json: async () => ({ responseCode: '2001', params: { state: 'APPROVED', transactionId: '777001', txAmount: '3.00' } }) });

beforeEach(() => {
  orderRow = { id: ORDER, status: 'PENDING_PAYMENT', total_amount: '3.00', kind: 'RIDE' };
  pendingAttempt = null;
  unknownAttempt = null;
  attempts.length = 0;
  [tx.paymentAttempt.create, tx.paymentAttempt.updateMany, enqueue, postMessage, auditAfter, confirmPayment].forEach((f) => f.mockClear());
});

describe('startWalletPayment', () => {
  test('off without credentials', async () => {
    await expect(startWalletPayment({ orderId: ORDER, wallet: 'sahal', phone: '901234567', settings: parseWaafiPay({}) }))
      .rejects.toThrow(/not available/);
  });

  test('refuses a wallet that is not offered, and a non-Somali payer', async () => {
    await expect(startWalletPayment({ orderId: ORDER, wallet: 'edahab', phone: '901234567', settings })).rejects.toThrow(/choose/);
    await expect(startWalletPayment({ orderId: ORDER, wallet: 'sahal', phone: '+12065550100', settings })).rejects.toThrow(/Somali/);
  });

  test('refuses an order that is already paid', async () => {
    orderRow.status = 'PAID_UNASSIGNED';
    await expect(startWalletPayment({ orderId: ORDER, wallet: 'sahal', phone: '901234567', settings })).rejects.toThrow(/already paid/);
  });

  test('a double tap returns the pending attempt; no second prompt', async () => {
    pendingAttempt = { id: 'p-1', order_id: ORDER, status: 'pending', wallet: 'sahal' };
    const fetchImpl = jest.fn(approved);
    const a = await startWalletPayment({ orderId: ORDER, wallet: 'sahal', phone: '901234567', settings, fetchImpl });
    expect(a.id).toBe('p-1');
    expect(tx.paymentAttempt.create).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a recent unknown answer blocks a new prompt (the first may have charged)', async () => {
    unknownAttempt = { id: 'u-1', status: 'unknown' };
    await expect(startWalletPayment({ orderId: ORDER, wallet: 'sahal', phone: '901234567', settings })).rejects.toThrow(/could not tell/);
  });

  test('records the attempt with the ORDER total, not anything the client says', async () => {
    const fetchImpl = jest.fn(approved);
    const a = await startWalletPayment({ orderId: ORDER, wallet: 'sahal', phone: '901234567', settings, fetchImpl });
    expect(a).toMatchObject({ order_id: ORDER, wallet: 'sahal', payer: '+252901234567', amount: '3.00', provider: 'waafipay' });
    await new Promise((r) => setTimeout(r, 0));
    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(sent.serviceParams.transactionInfo).toMatchObject({ referenceId: a.id, invoiceId: ORDER, amount: '3.00' });
  });
});

describe('settling an attempt', () => {
  const attempt = { id: 'a-1', order_id: ORDER, wallet: 'sahal', payer: '+252901234567', amount: '3.00', status: 'pending' };
  beforeEach(() => { attempts.push({ ...attempt }); });

  test('approved -> confirmPayment with the gateway reference, attempt approved in the same tx', async () => {
    const r = await settleWalletPayment({ attempt, accountNo: '252901234567', kind: 'RIDE', settings, fetchImpl: approved });
    expect(r).toBe('approved');
    expect(confirmPayment).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER, reference: '777001', amount: '3.00', provider: 'waafipay' }));
    expect(tx.paymentAttempt.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'approved', reference: '777001' }) }));
  });

  test('approved but not applicable (amount, cancelled order) -> audited as unmatched', async () => {
    confirmPayment.mockImplementationOnce(async () => { throw new PaymentError('amount 2.00 does not match', 409); });
    const r = await applyOutcome(attempt, { status: 'approved', reference: '777002', amount: '2.00' });
    expect(r).toBe('unmatched');
    expect(auditAfter).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment.unmatched' }));
  });

  test('declined -> attempt declined and the customer told they can retry', async () => {
    const declined = async () => ({ status: 200, json: async () => ({ responseCode: '5206', responseMsg: 'RCS_USER_REJECTED' }) });
    const r = await settleWalletPayment({ attempt, accountNo: '252901234567', kind: 'RIDE', settings, fetchImpl: declined });
    expect(r).toBe('declined');
    expect(confirmPayment).not.toHaveBeenCalled();
    expect(postMessage.mock.calls[0][0].body).toMatch(/try again/);
  });

  test('network failure -> unknown, never declined, nothing confirmed', async () => {
    const down = async () => { throw new TypeError('fetch failed'); };
    const r = await settleWalletPayment({ attempt, accountNo: '252901234567', kind: 'RIDE', settings, fetchImpl: down });
    expect(r).toBe('unknown');
    expect(confirmPayment).not.toHaveBeenCalled();
    expect(postMessage.mock.calls[0][0].body).toMatch(/I've paid/);
  });

  test('a late duplicate answer does not overwrite a settled attempt', async () => {
    tx.paymentAttempt.updateMany.mockResolvedValueOnce({ count: 0 });
    await applyOutcome(attempt, { status: 'declined', detail: 'late' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
