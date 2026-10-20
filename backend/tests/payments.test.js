// Payments without a device: the customer CLAIMS, the operator CONFIRMS. These are the rules
// that keep money honest when a person, not a sensor, is the source of truth:
//   * a claim never marks an order paid — anyone can tap a button;
//   * a confirmation records the payment AND moves the order, together, so a refund later knows
//     what is owed;
//   * one real payment (reference) can never confirm two orders (invariant 2).
// The DB transaction and downstream modules are mocked so these branches run without Postgres.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const transitionOrder = jest.fn(async (id, to) => ({ id, status: to }));
const postMessage = jest.fn(async () => ({}));
const enqueue = jest.fn();
const wakeOutbox = jest.fn();

let orderRow = null;
let usedReceipt = null;
const tx = {
  $queryRaw: jest.fn(async () => (orderRow ? [orderRow] : [])),
  order: { update: jest.fn(async ({ data }) => ({ ...orderRow, ...data })) },
  transaction: {
    findUnique: jest.fn(async () => usedReceipt),
    create: jest.fn(async ({ data }) => ({ id: 1n, ...data })),
  },
};

jest.unstable_mockModule('../src/db/prisma.js', () => ({
  prisma: tx,
  withTransaction: async (fn) => fn(tx),
  withCriticalTransaction: async (fn) => fn(tx),
  inTransaction: (c, fn) => (c ? fn(c) : fn(tx)),
}));
jest.unstable_mockModule('../src/commands/orders.js', () => ({ transitionOrder, postMessage }));
jest.unstable_mockModule('../src/events/bus.js', () => ({
  EVENTS: { PAYMENT_RECEIVED: 'payment.received', PAYMENT_CLAIMED: 'payment.claimed' },
}));
jest.unstable_mockModule('../src/events/outbox.js', () => ({ enqueue, wakeOutbox }));

const { claimPayment, confirmPayment } = await import('../src/commands/payments.js');
const { normalizeReference, manualReceiptId } = await import('../src/domain/paymentRef.js');

const ORDER = '9110aafa-fd8f-4469-8592-4d5f944952e3';
const pending = { id: ORDER, status: 'PENDING_PAYMENT', user_phone: '+252612345678', total_amount: '7.25' };

beforeEach(() => {
  orderRow = { ...pending };
  usedReceipt = null;
  [transitionOrder, postMessage, enqueue, wakeOutbox, tx.order.update, tx.transaction.create].forEach((f) => f.mockClear());
});

describe('normalizeReference', () => {
  test('one canonical form, so variants of the same reference collide', () => {
    expect(normalizeReference(' abc 123 ')).toBe('ABC123');
    expect(normalizeReference('abc-123')).toBe('ABC123');
    expect(normalizeReference('')).toBe('');
  });
  test('rejects things that are not references', () => {
    expect(normalizeReference('<script>')).toBeNull();
    expect(normalizeReference('x'.repeat(41))).toBeNull();
  });
});

describe('claimPayment (customer: "I\'ve paid")', () => {
  test('records the claim and tells operators — but does NOT mark the order paid', async () => {
    await claimPayment({ orderId: ORDER, reference: 'evc 991' });
    expect(tx.order.update.mock.calls[0][0].data.payment_claim_ref).toBe('EVC991');
    expect(enqueue).toHaveBeenCalledWith(tx, 'payment.claimed', expect.objectContaining({ orderId: ORDER }));
    expect(transitionOrder).not.toHaveBeenCalled();
    expect(tx.transaction.create).not.toHaveBeenCalled();
    expect(wakeOutbox).toHaveBeenCalled();
  });

  test('works without a reference', async () => {
    await claimPayment({ orderId: ORDER });
    expect(tx.order.update.mock.calls[0][0].data.payment_claim_ref).toBeNull();
  });

  test('an order that is already paid cannot be claimed', async () => {
    orderRow.status = 'PAID_UNASSIGNED';
    await expect(claimPayment({ orderId: ORDER })).rejects.toMatchObject({ status: 409 });
  });

  test('a garbage reference is refused', async () => {
    await expect(claimPayment({ orderId: ORDER, reference: '<b>' })).rejects.toMatchObject({ status: 400 });
  });

  const wallets = [
    { id: 'evc', name: 'EVC Plus', network: 'Hormuud', merchant: '612345678', template: '*712*{NUM}*{AMT}%23' },
    { id: 'edahab', name: 'eDahab', network: 'Somtel', merchant: '651234567', template: '*110*{NUM}*{AMT}%23' },
  ];

  test('records which wallet the customer paid with, so the operator checks the right phone', async () => {
    await claimPayment({ orderId: ORDER, reference: 'X1', wallet: 'edahab', wallets });
    expect(tx.order.update.mock.calls[0][0].data.payment_claim_wallet).toBe('edahab');
    expect(postMessage.mock.calls[0][0].body).toBe('Customer says they have paid with eDahab. Reference: X1');
    expect(enqueue).toHaveBeenCalledWith(tx, 'payment.claimed',
      expect.objectContaining({ wallet: 'edahab', walletName: 'eDahab' }));
  });

  test('no wallet is fine (old app builds, manual orders)', async () => {
    await claimPayment({ orderId: ORDER, wallets });
    expect(tx.order.update.mock.calls[0][0].data.payment_claim_wallet).toBeNull();
  });

  test('a wallet we do not offer is refused before anything is written', async () => {
    await expect(claimPayment({ orderId: ORDER, wallet: 'zaad', wallets })).rejects.toMatchObject({ status: 400 });
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});

describe('confirmPayment (operator saw the money)', () => {
  test('records the payment AND moves the order to PAID_UNASSIGNED, in the same transaction', async () => {
    await confirmPayment({ orderId: ORDER, reference: 'EVC991', actor: 'operator:1:hodan' });
    const row = tx.transaction.create.mock.calls[0][0].data;
    expect(row).toMatchObject({
      order_id: ORDER, telecom_receipt_id: 'EVC991', amount: '7.25', matched: true, provider: 'manual',
    });
    expect(transitionOrder).toHaveBeenCalledWith(ORDER, 'PAID_UNASSIGNED', 'operator:1:hodan', expect.any(String), { client: tx });
    expect(enqueue).toHaveBeenCalledWith(tx, 'payment.received', expect.objectContaining({ orderId: ORDER }));
  });

  test('without a reference it still records a payment, with a per-order receipt id', async () => {
    await confirmPayment({ orderId: ORDER, actor: 'operator:1:hodan' });
    expect(tx.transaction.create.mock.calls[0][0].data.telecom_receipt_id).toBe(manualReceiptId(ORDER));
  });

  test('a reference already used for another order is refused — one payment, one order', async () => {
    usedReceipt = { order_id: 'aaaaaaaa-0000-0000-0000-000000000000' };
    await expect(confirmPayment({ orderId: ORDER, reference: 'EVC991', actor: 'op' }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already used/) });
    expect(transitionOrder).not.toHaveBeenCalled();
  });

  test('an order that is not waiting for payment cannot be confirmed twice', async () => {
    orderRow.status = 'PAID_UNASSIGNED';
    await expect(confirmPayment({ orderId: ORDER, actor: 'op' })).rejects.toMatchObject({ status: 409 });
    expect(tx.transaction.create).not.toHaveBeenCalled();
  });

  test('an unknown order is a 404', async () => {
    orderRow = null;
    await expect(confirmPayment({ orderId: ORDER, actor: 'op' })).rejects.toMatchObject({ status: 404 });
  });
});
