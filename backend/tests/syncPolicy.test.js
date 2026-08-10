// The offline queue's decision logic (frontend/shared/syncPolicy.js), executed as the real
// browser file so the tests can't drift from what ships.
//
// The rule this enforces, from CLAUDE.md P2: the server's state machine always wins over a
// queued client transition, and a rejected action surfaces as "couldn't sync" — NEVER
// silently dropped. A driver who marked an order delivered in a dead zone must end up either
// with it delivered, or with a visible failure. Nothing in between.
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../frontend/shared/syncPolicy.js'), 'utf8');
const sandbox = { self: {}, module: undefined };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const GMSync = sandbox.self.GMSync;

const { DONE, RETRY, REJECTED } = GMSync;

describe('offline (no response at all)', () => {
  test('is always retryable — this is the normal case, not an error', () => {
    // A driver in a dead zone is the design target, not an edge case.
    expect(GMSync.classify({ status: 0, attempts: 1 }).action).toBe(RETRY);
    expect(GMSync.classify({ status: 0, attempts: 5 }).action).toBe(RETRY);
  });

  test('gives up eventually rather than retrying forever', () => {
    const v = GMSync.classify({ status: 0, attempts: GMSync.MAX_ATTEMPTS });
    expect(v.action).toBe(REJECTED);
    expect(v.reason).toMatch(/could not reach/i);
  });

  test('backs off exponentially with a ceiling', () => {
    // A phone that's been offline for an hour must not hammer the server the moment one bar
    // appears — but the ceiling keeps recovery from taking hours.
    expect(GMSync.backoffMs(1)).toBe(1000);
    expect(GMSync.backoffMs(2)).toBe(2000);
    expect(GMSync.backoffMs(3)).toBe(4000);
    expect(GMSync.backoffMs(50)).toBe(5 * 60 * 1000);
    expect(GMSync.backoffMs(0)).toBe(1000);
  });
});

describe('success', () => {
  test('2xx is done', () => {
    for (const status of [200, 201, 204]) {
      expect(GMSync.classify({ status }).action).toBe(DONE);
    }
  });
});

describe('409 conflict — where the server-wins rule actually lives', () => {
  test('a replay of an action that ALREADY landed counts as success', () => {
    // The response was lost, not the write. Telling a driver their delivery "failed to sync"
    // while the order sits there marked DELIVERED would be a lie.
    const v = GMSync.classify({
      status: 409,
      isTransitionTo: 'DELIVERED',
      currentStatus: 'DELIVERED',
    });
    expect(v.action).toBe(DONE);
    expect(v.note).toMatch(/already applied/);
  });

  test('a genuine conflict is rejected and explained, not retried', () => {
    // The order moved on (operator cancelled it, say). Retrying can never succeed.
    const v = GMSync.classify({
      status: 409,
      isTransitionTo: 'DELIVERED',
      currentStatus: 'FAILED_REFUND',
    });
    expect(v.action).toBe(REJECTED);
    expect(v.reason).toMatch(/server version wins/i);
  });

  test('a 409 with no state information is rejected rather than assumed applied', () => {
    // Guessing "probably fine" here would silently drop a driver's action.
    expect(GMSync.classify({ status: 409 }).action).toBe(REJECTED);
    expect(GMSync.classify({ status: 409, isTransitionTo: 'DELIVERED' }).action).toBe(REJECTED);
    expect(GMSync.classify({ status: 409, currentStatus: 'DELIVERED' }).action).toBe(REJECTED);
  });
});

describe('auth failures', () => {
  test('401/403 is held for retry, not thrown away', () => {
    // The action isn't wrong — the session expired. Discarding it would lose a real delivery.
    for (const status of [401, 403]) {
      const v = GMSync.classify({ status, attempts: 1 });
      expect(v.action).toBe(RETRY);
      expect(v.needsAuth).toBe(true);
    }
  });
});

describe('rate limiting', () => {
  test('429 always retries, and never faster than 5s', () => {
    const v = GMSync.classify({ status: 429, attempts: 1 });
    expect(v.action).toBe(RETRY);
    expect(v.retryInMs).toBeGreaterThanOrEqual(5000);
  });
});

describe('bad requests', () => {
  test('other 4xx are rejected — replaying them can never work', () => {
    for (const status of [400, 404, 413, 422]) {
      expect(GMSync.classify({ status }).action).toBe(REJECTED);
    }
  });
});

describe('server errors', () => {
  test('5xx retries — the server is unwell, the request is fine', () => {
    expect(GMSync.classify({ status: 500, attempts: 1 }).action).toBe(RETRY);
    expect(GMSync.classify({ status: 503, attempts: 2 }).action).toBe(RETRY);
  });

  test('but not forever', () => {
    expect(GMSync.classify({ status: 500, attempts: GMSync.MAX_ATTEMPTS }).action).toBe(REJECTED);
  });
});

describe('isDue', () => {
  test('a fresh item is due immediately', () => {
    expect(GMSync.isDue({ nextAttemptAt: 0 })).toBe(true);
    expect(GMSync.isDue({})).toBe(true);
  });

  test('a backed-off item waits', () => {
    const now = 1_000_000;
    expect(GMSync.isDue({ nextAttemptAt: now + 5000 }, now)).toBe(false);
    expect(GMSync.isDue({ nextAttemptAt: now - 1 }, now)).toBe(true);
  });
});

describe('describe() — what the driver actually reads', () => {
  test('failures outrank pending, because they need a decision', () => {
    expect(GMSync.describe({ pending: 3, failed: 1 }).tone).toBe('error');
    expect(GMSync.describe({ pending: 3, failed: 1 }).text).toMatch(/couldn't sync/);
  });

  test('pending reads as waiting, not as an error', () => {
    expect(GMSync.describe({ pending: 2, failed: 0 })).toMatchObject({ tone: 'pending' });
  });

  test('an empty queue is reassuring, not silent', () => {
    expect(GMSync.describe({ pending: 0, failed: 0 })).toMatchObject({
      tone: 'ok',
      text: 'All changes saved',
    });
  });

  test('singular and plural both read correctly', () => {
    expect(GMSync.describe({ failed: 1 }).text).toBe("1 change couldn't sync");
    expect(GMSync.describe({ failed: 2 }).text).toBe("2 changes couldn't sync");
  });
});
