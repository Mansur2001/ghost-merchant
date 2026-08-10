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

// A fake Prisma transaction client. `$queryRaw` is a tagged template, so it receives
// (stringsArray, ...values) — the order lookup uses it because FOR UPDATE has no model API.
let matchRows = [];
let dupRow = null;
const calls = { rawValues: null, created: null };

const tx = {
  $executeRawUnsafe: jest.fn(async () => 0),
  $queryRaw: jest.fn(async (_strings, ...values) => {
    calls.rawValues = values;
    return matchRows;
  }),
  transaction: {
    findUnique: jest.fn(async () => dupRow),
    create: jest.fn(async ({ data }) => {
      calls.created = data;
      return { id: 1n, ...data };
    }),
  },
};

jest.unstable_mockModule('../src/db/prisma.js', () => ({
  prisma: tx,
  withCriticalTransaction: async (fn) => fn(tx),
  withTransaction: async (fn) => fn(tx),
  inTransaction: (c, fn) => (c ? fn(c) : fn(tx)),
  WriteUnavailableError: class extends Error {},
}));
jest.unstable_mockModule('../src/commands/orders.js', () => ({ transitionOrder }));
jest.unstable_mockModule('../src/events/bus.js', () => ({
  EVENTS: { PAYMENT_RECEIVED: 'payment.received', ORDER_STATE_CHANGED: 'order.state_changed' },
  publish: jest.fn(),
}));
// Events go through the transactional outbox rather than straight to the bus.
jest.unstable_mockModule('../src/events/outbox.js', () => ({ enqueue, wakeOutbox }));

const { recordAndMatchPayment } = await import('../src/commands/payments.js');

// Configure the fakes for one scenario, and expose what the code passed them.
function scenario({ dupRows = [], matchRows: rows = [] } = {}) {
  dupRow = dupRows[0] || null;
  matchRows = rows;
  calls.rawValues = null;
  calls.created = null;
  return calls;
}

beforeEach(() => {
  transitionOrder.mockReset();
  enqueue.mockReset();
  wakeOutbox.mockReset();
  tx.transaction.create.mockClear();
  tx.$queryRaw.mockClear();
});

describe('clean single match', () => {
  test('records the receipt, advances the order to PAID_UNASSIGNED, and publishes', async () => {
    const calls = scenario({ matchRows: [{ id: 42 }] });

    const out = await recordAndMatchPayment({
      receiptId: 'RCPT-1', senderMsisdn: '612345678', amount: 7.25, rawSms: 'You received $7.25',
    });

    expect(out).toMatchObject({ duplicate: false, orderId: 42, ambiguous: false });
    // Sender normalized to canonical E.164 before matching (invariant #4).
    expect(calls.rawValues[0]).toBe('+252612345678');
    // Inserted as a matched transaction.
    expect(calls.created.order_id).toBe(42);
    expect(calls.created.matched).toBe(true);
    // The transition runs INSIDE this transaction (client passed through), so the receipt
    // and the status change commit together — no window where money is received but the
    // order still reads "awaiting payment".
    expect(transitionOrder).toHaveBeenCalledWith(
      42, 'PAID_UNASSIGNED', 'system', expect.any(String), { client: tx }
    );
    // The event is written to the outbox with the SAME transaction client, not published
    // directly — that is what makes it crash-safe.
    expect(enqueue).toHaveBeenCalledWith(
      tx, 'payment.received', expect.objectContaining({ orderId: 42, amount: 7.25 })
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
    expect(calls.created.order_id).toBeNull();
    expect(calls.created.matched).toBe(false);
    expect(transitionOrder).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('two identical-amount pending orders (ambiguous)', () => {
  test('leaves the payment unmatched for manual reconciliation rather than guessing', async () => {
    const calls = scenario({ matchRows: [{ id: 42 }, { id: 43 }] });

    const out = await recordAndMatchPayment({ receiptId: 'RCPT-3', senderMsisdn: '612345678', amount: 7.25 });

    expect(out).toMatchObject({ duplicate: false, orderId: null, ambiguous: true });
    expect(calls.created.order_id).toBeNull();
    expect(transitionOrder).not.toHaveBeenCalled();
  });
});

describe('unrecognized sender number', () => {
  test('keeps the raw sender value instead of throwing, so the operator can reconcile', async () => {
    const calls = scenario({ matchRows: [] });

    await recordAndMatchPayment({ receiptId: 'RCPT-4', senderMsisdn: '00000', amount: 1 });

    // Not a valid Somali MSISDN → stored verbatim, not normalized.
    expect(calls.rawValues[0]).toBe('00000');
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
