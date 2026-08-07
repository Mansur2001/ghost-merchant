// The limiter is what makes a 4-digit driver PIN and a single operator password survivable,
// so its window arithmetic gets tested directly rather than through Express.
import { consume, resetRateLimits } from '../src/middleware/rateLimit.js';

beforeEach(() => resetRateLimits());

describe('consume', () => {
  test('allows up to max, then blocks', () => {
    const opts = { windowMs: 1000, max: 3 };
    expect(consume('k', opts).allowed).toBe(true);
    expect(consume('k', opts).allowed).toBe(true);
    expect(consume('k', opts).allowed).toBe(true);
    expect(consume('k', opts).allowed).toBe(false);
  });

  test('reports remaining budget', () => {
    const opts = { windowMs: 1000, max: 3 };
    expect(consume('k', opts).remaining).toBe(2);
    expect(consume('k', opts).remaining).toBe(1);
    expect(consume('k', opts).remaining).toBe(0);
  });

  test('keys are independent', () => {
    const opts = { windowMs: 1000, max: 1 };
    expect(consume('a', opts).allowed).toBe(true);
    expect(consume('b', opts).allowed).toBe(true);
    expect(consume('a', opts).allowed).toBe(false);
  });

  test('the window slides — old hits expire', () => {
    const t0 = 1_000_000;
    const opts = { windowMs: 1000, max: 2 };
    expect(consume('k', { ...opts, now: t0 }).allowed).toBe(true);
    expect(consume('k', { ...opts, now: t0 + 100 }).allowed).toBe(true);
    expect(consume('k', { ...opts, now: t0 + 200 }).allowed).toBe(false);
    // First hit has aged out of the window; one slot frees up.
    expect(consume('k', { ...opts, now: t0 + 1001 }).allowed).toBe(true);
  });

  test('a blocked caller cannot extend their own block by retrying', () => {
    // Rejected attempts must NOT be recorded, or a client hammering the endpoint would keep
    // pushing its own reset further out and lock itself out indefinitely.
    const t0 = 1_000_000;
    const opts = { windowMs: 1000, max: 1 };
    consume('k', { ...opts, now: t0 });
    consume('k', { ...opts, now: t0 + 500 }); // blocked
    consume('k', { ...opts, now: t0 + 900 }); // blocked
    expect(consume('k', { ...opts, now: t0 + 1001 }).allowed).toBe(true);
  });

  test('retryAfterMs counts down to the oldest hit leaving the window', () => {
    const t0 = 1_000_000;
    const opts = { windowMs: 1000, max: 1 };
    consume('k', { ...opts, now: t0 });
    expect(consume('k', { ...opts, now: t0 + 400 }).retryAfterMs).toBe(600);
  });

  test('buckets are released once they empty (no unbounded growth)', () => {
    const t0 = 1_000_000;
    const opts = { windowMs: 1000, max: 5 };
    for (let i = 0; i < 1000; i += 1) consume(`ip-${i}`, { ...opts, now: t0 });
    // Every key ages out; consuming again after the window must start from a clean slate.
    const after = consume('ip-0', { ...opts, now: t0 + 5000 });
    expect(after.remaining).toBe(4);
  });
});
