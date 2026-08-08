// Payment matching is where the "distributed SMS system" fault tolerance lives. CLAUDE.md
// calls out the exact edge cases to protect: duplicate SMS (invariant #2 idempotency),
// wrong amount, two identical-amount orders (ambiguous), and unrecognized senders. We mock
// the DB transaction and the downstream side-effects (state machine + event bus) so these
// pure-logic branches can be exercised without Postgres.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// ── Mocks (must be registered before importing the module under test) ──
const transitionOrder = jest.fn();
const enqueue = jest.fn();
const wakeOutbox = jest.fn();

// A single mutable query handler the fake pg client delegates to; each test rewires it.
let queryImpl;
const client = { query: (sql, params) => queryImpl(sql, params) };

jest.unstable_mockModule('../src/db/pool.js', () => ({
  withTransaction: async (fn) => fn(client),
  query: jest.fn(),
}));
jest.unstable_mockModule('../src/commands/orders.js', () => ({ transitionOrder }));
jest.unstable_mockModule('../src/events/bus.js', () => ({
  EVENTS: { PAYMENT_RECEIVED: 'payment.received', ORDER_STATE_CHANGED: 'order.state_changed' },
  publish: jest.fn(),
}));
// Events now go through the transactional outbox rather than straight to the bus.
jest.unstable_mockModule('../src/events/outbox.js', () => ({ enqueue, wakeOutbox }));

const { recordAndMatchPayment } = await import('../src/commands/payments.js');

// Build a queryImpl from a small scenario spec. Records the params it was called with so
// tests can assert on the canonical sender + insert row.
function scenario({ dupRows = [], matchRows = [] } = {}) {
  const calls = { orderSelectParams: null, insertParams: null };
  queryImpl = (sql, params) => {
    if (/FROM transactions WHERE telecom_receipt_id/.test(sql)) {
      return { rowCount: dupRows.length, rows: dupRows };
    }
    if (/FROM orders/.test(sql)) {
      calls.orderSelectParams = params;
      return { rowCount: matchRows.length, rows: matchRows };
    }
    if (/INSERT INTO transactions/.test(sql)) {
      calls.insertParams = params;
      // Echo an inserted row shaped like RETURNING *.
      const [order_id, telecom_receipt_id, sender_msisdn, amount, raw_sms, matched] = params;
      return { rowCount: 1, rows: [{ id: 1, order_id, telecom_receipt_id, sender_msisdn, amount, raw_sms, matched }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  return calls;
}

beforeEach(() => {
  transitionOrder.mockReset();
  enqueue.mockReset();
  wakeOutbox.mockReset();
});

describe('clean single match', () => {
  test('records the receipt, advances the order to PAID_UNASSIGNED, and publishes', async () => {
    const calls = scenario({ matchRows: [{ id: 42 }] });

    const out = await recordAndMatchPayment({
      receiptId: 'RCPT-1', senderMsisdn: '612345678', amount: 7.25, rawSms: 'You received $7.25',
    });

    expect(out).toMatchObject({ duplicate: false, orderId: 42, ambiguous: false });
    // Sender normalized to canonical E.164 before matching (invariant #4).
    expect(calls.orderSelectParams[0]).toBe('+252612345678');
    // Inserted as a matched transaction.
    expect(calls.insertParams[0]).toBe(42); // order_id
    expect(calls.insertParams[5]).toBe(true); // matched
    // The transition runs INSIDE this transaction (client passed through), so the receipt
    // and the status change commit together — no window where money is received but the
    // order still reads "awaiting payment".
    expect(transitionOrder).toHaveBeenCalledWith(
      42, 'PAID_UNASSIGNED', 'system', expect.any(String), { client }
    );
    // The event is written to the outbox with the SAME transaction client, not published
    // directly — that is what makes it crash-safe.
    expect(enqueue).toHaveBeenCalledWith(
      client, 'payment.received', expect.objectContaining({ orderId: 42, amount: 7.25 })
    );
  });
});

describe('duplicate SMS webhook (idempotency, invariant #2)', () => {
  test('a replayed receipt credits nothing a second time', async () => {
    scenario({ dupRows: [{ id: 9, order_id: 42, matched: true }] });

    const out = await recordAndMatchPayment({ receiptId: 'RCPT-1', senderMsisdn: '612345678', amount: 7.25 });

    expect(out).toMatchObject({ duplicate: true, orderId: 42 });
    // Critically: no re-transition, no second event.
    expect(transitionOrder).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('wrong amount / no matching order', () => {
  test('records an unmatched transaction for the operator and does not move any order', async () => {
    const calls = scenario({ matchRows: [] });

    const out = await recordAndMatchPayment({ receiptId: 'RCPT-2', senderMsisdn: '612345678', amount: 999 });

    expect(out).toMatchObject({ duplicate: false, orderId: null, ambiguous: false });
    expect(calls.insertParams[0]).toBeNull(); // order_id
    expect(calls.insertParams[5]).toBe(false); // matched
    expect(transitionOrder).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('two identical-amount pending orders (ambiguous)', () => {
  test('leaves the payment unmatched for manual reconciliation rather than guessing', async () => {
    const calls = scenario({ matchRows: [{ id: 42 }, { id: 43 }] });

    const out = await recordAndMatchPayment({ receiptId: 'RCPT-3', senderMsisdn: '612345678', amount: 7.25 });

    expect(out).toMatchObject({ duplicate: false, orderId: null, ambiguous: true });
    expect(calls.insertParams[0]).toBeNull();
    expect(transitionOrder).not.toHaveBeenCalled();
  });
});

describe('unrecognized sender number', () => {
  test('keeps the raw sender value instead of throwing, so the operator can reconcile', async () => {
    const calls = scenario({ matchRows: [] });

    await recordAndMatchPayment({ receiptId: 'RCPT-4', senderMsisdn: '00000', amount: 1 });

    // Not a valid Somali MSISDN → stored verbatim, not normalized.
    expect(calls.orderSelectParams[0]).toBe('00000');
  });
});

describe('malformed webhook input', () => {
  test('a missing receiptId is rejected before touching the DB', async () => {
    scenario();
    await expect(
      recordAndMatchPayment({ senderMsisdn: '612345678', amount: 1 })
    ).rejects.toThrow(/receiptId/);
  });
});
