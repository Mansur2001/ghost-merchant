// No human leverage over money or dispatch:
//   * drivers are chosen by a fixed rule (fewest active jobs, then longest wait), never by hand;
//   * a payment callback is accepted only with a valid, fresh signature.
import { describe, test, expect } from '@jest/globals';
import { pickDriver, MAX_ACTIVE_PER_DRIVER } from '../src/domain/dispatch.js';
import { signPayload, verifyWebhook, MAX_SKEW_SECONDS } from '../src/domain/paymentWebhook.js';

const d = (id, active_orders, last, extra = {}) =>
  ({ id: BigInt(id), active: true, ready: true, active_orders, last_assigned_at: last, ...extra });

describe('pickDriver — fair, automatic dispatch', () => {
  test('the driver with the fewest active jobs gets it', () => {
    expect(pickDriver([d(1, 2, null), d(2, 0, null), d(3, 1, null)]).id).toBe(2n);
  });

  test('a tie goes to whoever has waited longest since their last order', () => {
    const picked = pickDriver([d(1, 0, '2026-11-05T10:00:00Z'), d(2, 0, '2026-11-05T08:00:00Z'), d(3, 0, '2026-11-05T09:00:00Z')]);
    expect(picked.id).toBe(2n);
  });

  test('a driver who has never had an order goes before one who has', () => {
    expect(pickDriver([d(1, 0, '2026-11-05T08:00:00Z'), d(2, 0, null)]).id).toBe(2n);
  });

  test('rotation: assigning repeatedly spreads orders across everyone', () => {
    const drivers = [d(1, 0, null), d(2, 0, null), d(3, 0, null)];
    const got = [];
    for (let i = 0; i < 6; i += 1) {
      const p = pickDriver(drivers);
      got.push(Number(p.id));
      p.active_orders += 1;
      p.last_assigned_at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    }
    expect(got.slice(0, 3).sort()).toEqual([1, 2, 3]);
    expect(got.slice(3).sort()).toEqual([1, 2, 3]);
  });

  test('inactive drivers, drivers who never set a PIN, and full drivers are skipped', () => {
    expect(pickDriver([
      d(1, 0, null, { active: false }),
      d(2, 0, null, { ready: false }),
      d(3, MAX_ACTIVE_PER_DRIVER, null),
    ])).toBeNull();
  });
});

describe('verifyWebhook — only the provider can say "paid"', () => {
  const secret = 'x'.repeat(40);
  const body = JSON.stringify({ orderId: '9110aafa-fd8f-4469-8592-4d5f944952e3', reference: 'EVC1', amount: '7.50' });
  const now = Date.UTC(2026, 10, 6, 12, 0, 0);
  const ts = Math.floor(now / 1000);

  test('a correctly signed, fresh callback passes', () => {
    expect(verifyWebhook({ secret, timestamp: String(ts), signature: signPayload(secret, ts, body), rawBody: body, now })).toBeNull();
  });

  test('a changed body (e.g. a different amount) fails', () => {
    const sig = signPayload(secret, ts, body);
    expect(verifyWebhook({ secret, timestamp: String(ts), signature: sig, rawBody: body.replace('7.50', '0.01'), now })).toBe('bad signature');
  });

  test('a replay outside the 5-minute window fails, even with a valid signature', () => {
    const old = ts - MAX_SKEW_SECONDS - 1;
    expect(verifyWebhook({ secret, timestamp: String(old), signature: signPayload(secret, old, body), rawBody: body, now }))
      .toMatch(/window/);
  });

  test('the wrong secret, a missing signature, or no secret configured all fail', () => {
    expect(verifyWebhook({ secret, timestamp: String(ts), signature: signPayload('y'.repeat(40), ts, body), rawBody: body, now })).toBe('bad signature');
    expect(verifyWebhook({ secret, timestamp: String(ts), signature: undefined, rawBody: body, now })).toMatch(/signature/);
    expect(verifyWebhook({ secret: '', timestamp: String(ts), signature: 'a'.repeat(64), rawBody: body, now })).toMatch(/not configured/);
  });
});
