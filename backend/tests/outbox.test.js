// The outbox is the thing that keeps "the database says it happened" and "everyone connected
// knows it happened" from drifting apart. Its interesting behaviour is all in the failure
// paths — crash mid-batch, a consumer that throws, a poison event — so that's what's tested.
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const publish = jest.fn();
let queryImpl;
const client = { query: (sql, params) => queryImpl(sql, params) };
const poolQuery = jest.fn();

// The relay holds a DEDICATED connection for its advisory lock (a session-scoped lock is
// released the moment the client goes back to the pool), so the fake pool hands out a client
// whose query() answers the leadership probe.
let leadershipGranted = true;
const lockClient = {
  query: jest.fn(async (sql) => {
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: leadershipGranted }] };
    if (/pg_advisory_unlock/.test(sql)) return { rows: [{}] };
    throw new Error(`unexpected lock query: ${sql}`);
  }),
  release: jest.fn(),
};

jest.unstable_mockModule('../src/db/pool.js', () => ({
  pool: { connect: async () => lockClient },
  withTransaction: async (fn) => fn(client),
  query: poolQuery,
  inTransaction: (c, fn) => (c ? fn(c) : fn(client)),
}));
jest.unstable_mockModule('../src/events/bus.js', () => ({
  publish,
  EVENTS: { ORDER_STATE_CHANGED: 'order.state_changed' },
}));

const { enqueue, relayOnce, outboxHealth, sweepOutbox } = await import('../src/events/outbox.js');

// Fake outbox table: rows the relay will SELECT, plus a record of the UPDATEs it issues.
function tableWith(rows) {
  const updates = [];
  queryImpl = (sql, params) => {
    if (/SELECT id, event_name/.test(sql)) return { rows, rowCount: rows.length };
    if (/UPDATE outbox SET published_at/.test(sql)) {
      updates.push({ kind: 'published', id: params[0] });
      return { rowCount: 1 };
    }
    if (/UPDATE outbox SET attempts/.test(sql)) {
      updates.push({ kind: 'retry', attempts: params[0], error: params[1], failed: params[2], id: params[3] });
      return { rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  return updates;
}

beforeEach(() => {
  publish.mockReset();
  poolQuery.mockReset();
});

describe('enqueue', () => {
  test('writes the event using the caller transaction client', async () => {
    const captured = [];
    const tx = { query: (sql, params) => { captured.push({ sql, params }); return { rows: [{ id: 7 }] }; } };
    const id = await enqueue(tx, 'order.state_changed', { orderId: 1, to: 'DELIVERED' });
    expect(id).toBe(7);
    expect(captured[0].sql).toMatch(/INSERT INTO outbox/);
    expect(JSON.parse(captured[0].params[1])).toEqual({ orderId: 1, to: 'DELIVERED' });
  });

  test('REFUSES to run without a transaction client', async () => {
    // The whole mechanism depends on the event row committing with the state change. Writing
    // it on the pool would commit independently — silently reintroducing the bug we fixed.
    await expect(enqueue(null, 'x', {})).rejects.toThrow(/transaction client/);
    await expect(enqueue({}, 'x', {})).rejects.toThrow(/transaction client/);
    await expect(enqueue(undefined, 'x', {})).rejects.toThrow(/transaction client/);
  });

  test('serializes a null/undefined payload rather than writing NULL', async () => {
    const captured = [];
    const tx = { query: (sql, params) => { captured.push(params); return { rows: [{ id: 1 }] }; } };
    await enqueue(tx, 'x');
    expect(captured[0][1]).toBe('{}');
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
    let seenSql = '';
    queryImpl = (sql) => {
      if (/SELECT id, event_name/.test(sql)) { seenSql = sql; return { rows: [], rowCount: 0 }; }
      throw new Error('unexpected');
    };
    await relayOnce();
    expect(seenSql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(seenSql).toMatch(/published_at IS NULL AND NOT failed/);
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
    poolQuery.mockResolvedValue({ rows: [{ pending: 3, parked: 1, oldest_pending_seconds: 42 }] });
    expect(await outboxHealth()).toEqual({ pending: 3, parked: 1, oldest_pending_seconds: 42 });
  });
});

describe('sweepOutbox', () => {
  test('only deletes rows that were actually delivered', async () => {
    poolQuery.mockResolvedValue({ rowCount: 12 });
    expect(await sweepOutbox()).toBe(12);
    const [sql] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/published_at IS NOT NULL/);
    // An undelivered row must never be swept — that would silently lose the event.
    expect(sql).not.toMatch(/published_at IS NULL/);
  });
});

// ── Relay leadership ──
// Ordering by id only holds with ONE relay. Two instances each claiming a different subset
// via SKIP LOCKED would publish concurrently, and a customer could see "delivered" before
// "in transit". Leadership is what prevents that once more than one backend runs.
describe('relay leadership', () => {
  test('the relay claims a Postgres advisory lock on its dedicated connection', async () => {
    const { startOutboxRelay, stopOutboxRelay, isRelayLeader } =
      await import('../src/events/outbox.js');
    leadershipGranted = true;
    lockClient.query.mockClear();
    tableWith([]);

    startOutboxRelay();
    await new Promise((r) => setTimeout(r, 20));

    expect(lockClient.query.mock.calls.some(([sql]) => /pg_try_advisory_lock/.test(sql))).toBe(true);
    expect(isRelayLeader()).toBe(true);
    await stopOutboxRelay();
  });

  test('an instance that loses the election does not relay', async () => {
    // The whole point: the non-leader must publish NOTHING, or ordering is lost.
    jest.resetModules();
    leadershipGranted = false;
    publish.mockClear();
    const mod = await import('../src/events/outbox.js');
    tableWith([{ id: 1, event_name: 'order.state_changed', payload: {}, attempts: 0 }]);

    mod.startOutboxRelay();
    await new Promise((r) => setTimeout(r, 30));

    expect(mod.isRelayLeader()).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    await mod.stopOutboxRelay();
    leadershipGranted = true;
  });

  test('shutdown releases the lock so failover does not wait for a connection timeout', async () => {
    jest.resetModules();
    leadershipGranted = true;
    const mod = await import('../src/events/outbox.js');
    tableWith([]);
    mod.startOutboxRelay();
    await new Promise((r) => setTimeout(r, 20));
    lockClient.query.mockClear();

    await mod.stopOutboxRelay();

    expect(lockClient.query.mock.calls.some(([sql]) => /pg_advisory_unlock/.test(sql))).toBe(true);
    expect(mod.isRelayLeader()).toBe(false);
  });
});
