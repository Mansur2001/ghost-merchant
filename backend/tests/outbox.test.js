// The outbox is the thing that keeps "the database says it happened" and "everyone connected
// knows it happened" from drifting apart. Its interesting behaviour is all in the failure
// paths — crash mid-batch, a consumer that throws, a poison event — so that's what's tested.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const publish = jest.fn();

// Fake Prisma transaction client.
//  * `$queryRaw` serves both the leadership probe (pg_try_advisory_xact_lock) and the
//    SKIP LOCKED batch fetch, so it dispatches on the SQL text.
//  * `outbox.update` records what the relay marked, which is what the tests assert on.
let pendingRows = [];
let leadershipGranted = true;
let updates = [];

const tx = {
  $executeRawUnsafe: jest.fn(async () => 0),
  $queryRaw: jest.fn(async (strings) => {
    const sql = Array.isArray(strings) ? strings.join('') : String(strings);
    if (/pg_try_advisory_xact_lock/.test(sql)) return [{ ok: leadershipGranted }];
    if (/FROM outbox/.test(sql)) return pendingRows;
    throw new Error(`unexpected raw query: ${sql}`);
  }),
  outbox: {
    create: jest.fn(async ({ data }) => ({ id: 7n, ...data })),
    update: jest.fn(async ({ where, data }) => {
      if (data.published_at) updates.push({ kind: 'published', id: where.id });
      else {
        updates.push({
          kind: 'retry',
          attempts: data.attempts,
          error: data.last_error,
          failed: data.failed,
          id: where.id,
        });
      }
      return {};
    }),
  },
};

const prismaMock = {
  outbox: { count: jest.fn(), findFirst: jest.fn(), deleteMany: jest.fn() },
};

jest.unstable_mockModule('../src/db/prisma.js', () => ({
  prisma: prismaMock,
  withTransaction: async (fn) => fn(tx),
  withCriticalTransaction: async (fn) => fn(tx),
  inTransaction: (c, fn) => (c ? fn(c) : fn(tx)),
  WriteUnavailableError: class extends Error {},
}));
jest.unstable_mockModule('../src/events/bus.js', () => ({
  publish,
  EVENTS: { ORDER_STATE_CHANGED: 'order.state_changed' },
}));

const { enqueue, relayOnce, outboxHealth, sweepOutbox } = await import('../src/events/outbox.js');

// Stage the rows the relay will fetch; returns the log of marks it makes.
function tableWith(rows) {
  pendingRows = rows;
  updates = [];
  return updates;
}

beforeEach(() => {
  publish.mockReset();
  leadershipGranted = true;
  pendingRows = [];
  updates = [];
  tx.outbox.update.mockClear();
  prismaMock.outbox.count.mockReset();
  prismaMock.outbox.findFirst.mockReset();
  prismaMock.outbox.deleteMany.mockReset();
});

describe('enqueue', () => {
  test('writes the event using the caller transaction client', async () => {
    const id = await enqueue(tx, 'order.state_changed', { orderId: 1, to: 'DELIVERED' });
    expect(id).toBe(7n);
    expect(tx.outbox.create).toHaveBeenCalledWith({
      data: { event_name: 'order.state_changed', payload: { orderId: 1, to: 'DELIVERED' } },
      select: { id: true },
    });
  });

  test('REFUSES to run without a transaction client', async () => {
    // The whole mechanism depends on the event row committing with the state change. Writing
    // it on the pool would commit independently — silently reintroducing the bug we fixed.
    await expect(enqueue(null, 'x', {})).rejects.toThrow(/transaction client/);
    await expect(enqueue({}, 'x', {})).rejects.toThrow(/transaction client/);
    await expect(enqueue(undefined, 'x', {})).rejects.toThrow(/transaction client/);
  });

  test('stores an empty object rather than NULL for a missing payload', async () => {
    tx.outbox.create.mockClear();
    await enqueue(tx, 'x');
    expect(tx.outbox.create.mock.calls[0][0].data.payload).toEqual({});
  });
});

describe('relayOnce', () => {
  test('publishes pending events and marks them delivered', async () => {
    const updates = tableWith([
      { id: 1, event_name: 'order.state_changed', payload: { orderId: 1 }, attempts: 0 },
      { id: 2, event_name: 'message.posted', payload: { orderId: 1 }, attempts: 0 },
    ]);

    const out = await relayOnce();

    expect(out).toEqual({ fetched: 2, delivered: 2 });
    expect(publish).toHaveBeenNthCalledWith(1, 'order.state_changed', { orderId: 1 });
    expect(publish).toHaveBeenNthCalledWith(2, 'message.posted', { orderId: 1 });
    expect(updates).toEqual([{ kind: 'published', id: 1 }, { kind: 'published', id: 2 }]);
  });

  test('publishes in id order, which is write order', async () => {
    // A customer must never see "delivered" before "in transit".
    tableWith([
      { id: 10, event_name: 'a', payload: {}, attempts: 0 },
      { id: 11, event_name: 'b', payload: {}, attempts: 0 },
      { id: 12, event_name: 'c', payload: {}, attempts: 0 },
    ]);
    await relayOnce();
    expect(publish.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
  });

  test('locks rows so a second relay cannot double-deliver', async () => {
    tableWith([]);
    await relayOnce();
    const sql = tx.$queryRaw.mock.calls
      .map(([strings]) => (Array.isArray(strings) ? strings.join('') : ''))
      .join(' ');
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/published_at IS NULL AND NOT failed/);
  });

  test('an empty queue is a no-op', async () => {
    tableWith([]);
    expect(await relayOnce()).toEqual({ fetched: 0, delivered: 0 });
    expect(publish).not.toHaveBeenCalled();
  });

  test('a failing consumer increments attempts and does NOT mark the event delivered', async () => {
    publish.mockImplementation(() => { throw new Error('socket layer exploded'); });
    const updates = tableWith([{ id: 5, event_name: 'x', payload: {}, attempts: 0 }]);

    const out = await relayOnce();

    expect(out.delivered).toBe(0);
    expect(updates).toEqual([
      { kind: 'retry', attempts: 1, error: 'socket layer exploded', failed: false, id: 5 },
    ]);
  });

  test('stops the batch at a failure so later events cannot overtake it', async () => {
    // Delivering event 2 while event 1 is still failing would reorder that order's history.
    publish.mockImplementation((name) => { if (name === 'first') throw new Error('nope'); });
    tableWith([
      { id: 1, event_name: 'first', payload: {}, attempts: 0 },
      { id: 2, event_name: 'second', payload: {}, attempts: 0 },
    ]);

    await relayOnce();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('first', {});
  });

  test('parks a poison event after MAX_ATTEMPTS instead of wedging the queue forever', async () => {
    // Postgres is still the source of truth and clients resync on reload, so one dropped
    // notification beats a relay that never moves again.
    publish.mockImplementation(() => { throw new Error('always fails'); });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const updates = tableWith([{ id: 5, event_name: 'x', payload: {}, attempts: 4 }]);

    await relayOnce();

    expect(updates[0]).toMatchObject({ kind: 'retry', attempts: 5, failed: true, id: 5 });
    expect(errSpy.mock.calls[0][0]).toMatch(/PARKED/);
    errSpy.mockRestore();
  });

  test('continues past a parked event to the next one', async () => {
    let calls = 0;
    publish.mockImplementation(() => { calls += 1; if (calls === 1) throw new Error('bad'); });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // attempts: 4 means this failure parks it, so the relay should move on rather than break.
    tableWith([
      { id: 1, event_name: 'poison', payload: {}, attempts: 4 },
      { id: 2, event_name: 'good', payload: {}, attempts: 0 },
    ]);

    const out = await relayOnce();

    expect(publish).toHaveBeenCalledTimes(2);
    expect(out.delivered).toBe(1);
    errSpy.mockRestore();
  });

  test('truncates a huge error message rather than storing it whole', async () => {
    publish.mockImplementation(() => { throw new Error('x'.repeat(5000)); });
    const updates = tableWith([{ id: 1, event_name: 'x', payload: {}, attempts: 0 }]);
    await relayOnce();
    expect(updates[0].error.length).toBeLessThanOrEqual(500);
  });
});

describe('outboxHealth', () => {
  test('reports backlog depth and age', async () => {
    prismaMock.outbox.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    prismaMock.outbox.findFirst.mockResolvedValue({ created_at: new Date(Date.now() - 42_000) });
    const health = await outboxHealth();
    expect(health.pending).toBe(3);
    expect(health.parked).toBe(1);
    expect(health.oldest_pending_seconds).toBeGreaterThanOrEqual(41);
  });

  test('an empty queue reports zero age, not a negative or NaN', async () => {
    prismaMock.outbox.count.mockResolvedValue(0);
    prismaMock.outbox.findFirst.mockResolvedValue(null);
    expect(await outboxHealth()).toEqual({ pending: 0, parked: 0, oldest_pending_seconds: 0 });
  });
});

describe('sweepOutbox', () => {
  test('only deletes rows that were actually delivered', async () => {
    prismaMock.outbox.deleteMany.mockResolvedValue({ count: 12 });
    expect(await sweepOutbox()).toBe(12);
    const { where } = prismaMock.outbox.deleteMany.mock.calls[0][0];
    // An undelivered row must never be swept — that would silently lose the event.
    expect(where.published_at.not).toBeNull();
    expect(where.published_at.lt).toBeInstanceOf(Date);
  });
});

// ── Relay leadership ──
// Ordering by id only holds with ONE relay running at a time. Two instances each claiming a
// different subset via SKIP LOCKED would publish concurrently, and a customer could see
// "delivered" before "in transit". The lock is transaction-scoped, so it is released at
// commit — no lease to expire and nothing to release on shutdown.
describe('relay leadership', () => {
  test('the relay takes a transaction-scoped advisory lock before reading', async () => {
    tableWith([]);
    await relayOnce();
    const sql = tx.$queryRaw.mock.calls
      .map(([strings]) => (Array.isArray(strings) ? strings.join('') : ''))
      .join(' ');
    expect(sql).toMatch(/pg_try_advisory_xact_lock/);
  });

  test('an instance that loses the election publishes NOTHING', async () => {
    // The whole point: a second relay must not deliver, or ordering is lost.
    leadershipGranted = false;
    tableWith([{ id: 1n, event_name: 'order.state_changed', payload: {}, attempts: 0 }]);

    const out = await relayOnce();

    expect(out).toEqual({ fetched: 0, delivered: 0, skipped: true });
    expect(publish).not.toHaveBeenCalled();
  });

  test('the winner relays normally', async () => {
    leadershipGranted = true;
    tableWith([{ id: 1n, event_name: 'order.state_changed', payload: { orderId: 'x' }, attempts: 0 }]);

    const out = await relayOnce();

    expect(out.delivered).toBe(1);
    expect(publish).toHaveBeenCalledWith('order.state_changed', { orderId: 'x' });
  });
});
