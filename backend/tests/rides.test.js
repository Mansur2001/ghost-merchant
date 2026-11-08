// Rides, the priced cart, ride dispatch, ride proofs and the WaafiPay wire format.
// Pure-domain: no database, no network.
import { describe, test, expect } from '@jest/globals';
import {
  priceCart, rideFareCents, deliveryFeeCents, parseTariff, DEFAULT_TARIFF, PricingError, toCents, fromCents,
} from '../src/domain/pricing.js';
import { parsePoint, inServiceArea, estimateRoadMeters, etaMinutes, nearestPlace } from '../src/domain/geo.js';
import { pickRideDriver, LOCATION_FRESH_MS, RIDE_RADIUS_M } from '../src/domain/dispatch.js';
import { buildProof } from '../src/domain/proof.js';
import { canTransition, autoResponse } from '../src/domain/stateMachine.js';
import {
  parseWaafiPay, buildPurchaseRequest, readPurchaseResponse, payerAccountNo, WAAFIPAY_PRODUCTION_URL,
} from '../src/domain/waafipay.js';
import { routeBetween } from '../src/routing/route.js';

const BAKAARA = { lat: 2.0469, lng: 45.3182 };
const LIDO = { lat: 2.057, lng: 45.3625 };

const catalog = new Map([
  [1, { id: 1, name_en: 'Rice', name_so: 'Bariis', unit_en: '5 kg', unit_so: '5 kg', price: '5.00' }],
  [2, { id: 2, name_en: 'Milk', name_so: 'Caano', unit_en: '1 L', unit_so: '1 litir', price: '1.20' }],
]);

describe('priceCart — the server prices every cart', () => {
  test('lines are priced from the catalog, in cents, never from the client', () => {
    const { items, subtotalCents } = priceCart({ lines: [{ itemId: 1, qty: 2 }, { itemId: 2, qty: 3 }] }, catalog);
    expect(subtotalCents).toBe(1360);
    expect(items[0]).toMatchObject({ item_id: 1, qty: 2, unit_price: '5.00', line_total: '10.00', text: '2 × Rice (5 kg)' });
    expect(items[1].line_total).toBe('3.60');
  });

  test('a price or total sent by the client is ignored', () => {
    const { subtotalCents } = priceCart({ lines: [{ itemId: 2, qty: 1, price: '0.01', unit_price: '0.01' }] }, catalog);
    expect(subtotalCents).toBe(120);
  });

  test('duplicate lines merge (a double tap is one line of 2)', () => {
    const { items } = priceCart({ lines: [{ itemId: 2, qty: 1 }, { itemId: 2, qty: 1 }] }, catalog);
    expect(items).toHaveLength(1);
    expect(items[0].qty).toBe(2);
  });

  test('an item no longer in the catalog is refused with 409, not silently dropped', () => {
    expect(() => priceCart({ lines: [{ itemId: 99, qty: 1 }] }, catalog)).toThrow(/no longer available/);
    try { priceCart({ lines: [{ itemId: 99, qty: 1 }] }, catalog); } catch (e) { expect(e.status).toBe(409); }
  });

  test.each([0, -1, 1.5, 51, 'x', null])('quantity %p is refused', (qty) => {
    expect(() => priceCart({ lines: [{ itemId: 1, qty }] }, catalog)).toThrow(PricingError);
  });

  test('merged duplicates still respect the quantity cap', () => {
    expect(() => priceCart({ lines: [{ itemId: 1, qty: 30 }, { itemId: 1, qty: 30 }] }, catalog)).toThrow(/quantity/);
  });

  test('a custom request carries its own budget; it needs a description', () => {
    const { items, subtotalCents } = priceCart({ custom: { text: 'Red school shoes size 34', budget: '8.5' } }, catalog);
    expect(subtotalCents).toBe(850);
    expect(items[0]).toMatchObject({ custom: true, text: 'Red school shoes size 34', budget: '8.50' });
    expect(() => priceCart({ custom: { text: '', budget: 5 } }, catalog)).toThrow(/describe/);
    expect(() => priceCart({ custom: { text: 'shoes', budget: 0.1 } }, catalog)).toThrow(/budget/);
    expect(() => priceCart({ custom: { text: 'shoes', budget: 5000 } }, catalog)).toThrow(/budget/);
  });

  test('an empty cart is refused', () => {
    expect(() => priceCart({ lines: [] }, catalog)).toThrow(/empty/);
  });

  test('too many lines are refused', () => {
    const lines = Array.from({ length: 31 }, (_, i) => ({ itemId: i + 1, qty: 1 }));
    expect(() => priceCart({ lines }, catalog)).toThrow(/at most/);
  });
});

describe('fares and fees', () => {
  test('a ride fare is base + per km, never under the minimum, ending in a whole 10 cents', () => {
    expect(rideFareCents(500, 'bajaj')).toBe(150); // minimum
    expect(rideFareCents(5000, 'bajaj')).toBe(300); // 1.00 + 5 x 0.40
    expect(rideFareCents(5000, 'car')).toBe(550); // 2.00 + 5 x 0.70
    expect(rideFareCents(5123, 'bajaj') % 10).toBe(0);
  });

  test('a car costs more than a bajaj for the same trip', () => {
    for (const m of [1000, 4000, 12000]) expect(rideFareCents(m, 'car')).toBeGreaterThan(rideFareCents(m, 'bajaj'));
  });

  test('an unknown vehicle or a trip across the country is refused', () => {
    expect(() => rideFareCents(1000, 'plane')).toThrow(PricingError);
    expect(() => rideFareCents(51_000, 'car')).toThrow(/too far/);
  });

  test('a delivery fee includes the first 2 km', () => {
    expect(deliveryFeeCents(0)).toBe(100);
    expect(deliveryFeeCents(2000)).toBe(100);
    expect(deliveryFeeCents(4000)).toBe(160);
    expect(() => deliveryFeeCents(31_000)).toThrow(/too far/);
  });

  test('cents survive the round trip', () => {
    expect(fromCents(toCents('7.25') + toCents(0.1) + toCents(0.2))).toBe('7.55');
  });

  test('tariff from env: overrides apply, bad values are collected', () => {
    const { tariff, errors } = parseTariff({ RIDE_CAR_BASE: '2.5', DELIVERY_PER_KM: 'abc', RIDE_BAJAJ_MIN: '-1' });
    expect(tariff.ride.car.base).toBe(2.5);
    expect(errors).toHaveLength(2);
    expect(DEFAULT_TARIFF.ride.car.base).toBe(2.0); // defaults are not mutated
  });
});

describe('geo', () => {
  test('points are rounded to 6 decimals and garbage is refused', () => {
    expect(parsePoint({ lat: '2.04691234', lng: 45.31821239 })).toEqual({ lat: 2.046912, lng: 45.318212 });
    expect(parsePoint({ lat: 'x', lng: 1 })).toBeNull();
    expect(parsePoint({ lat: 91, lng: 1 })).toBeNull();
    expect(parsePoint(null)).toBeNull();
  });

  test('the service area is Somalia, not the world', () => {
    expect(inServiceArea(BAKAARA)).toBe(true);
    expect(inServiceArea({ lat: 9.56, lng: 44.06 })).toBe(true); // Hargeisa
    expect(inServiceArea({ lat: 47.6, lng: -122.3 })).toBe(false); // Seattle
    expect(inServiceArea({ lat: 0, lng: 0 })).toBe(false); // a phone with no fix
  });

  test('road estimate is longer than the straight line; ETA never zero', () => {
    const m = estimateRoadMeters(BAKAARA, LIDO);
    expect(m).toBeGreaterThan(5000);
    expect(m).toBeLessThan(7500);
    expect(etaMinutes(0)).toBe(1);
    expect(etaMinutes(3000)).toBe(10);
  });

  test('nearestPlace picks the closest', () => {
    const near = nearestPlace({ lat: 2.047, lng: 45.319 }, [{ id: 1, ...LIDO }, { id: 2, ...BAKAARA }]);
    expect(near.place.id).toBe(2);
  });
});

describe('routeBetween — OSRM optional, never required', () => {
  test('no ROUTING_URL: the estimate', async () => {
    const r = await routeBetween(BAKAARA, LIDO, { url: '' });
    expect(r.source).toBe('estimate');
  });

  test('a sane OSRM answer is used', async () => {
    const straight = estimateRoadMeters(BAKAARA, LIDO) / 1.3;
    const fetchImpl = async () => ({ ok: true, json: async () => ({ code: 'Ok', routes: [{ distance: straight * 1.4, duration: 600 }] }) });
    const r = await routeBetween(BAKAARA, LIDO, { url: 'http://osrm', fetchImpl });
    expect(r.source).toBe('osrm');
    expect(r.meters).toBe(Math.round(straight * 1.4));
  });

  test('a broken, absurd or unreachable OSRM falls back to the estimate', async () => {
    const absurd = async () => ({ ok: true, json: async () => ({ code: 'Ok', routes: [{ distance: 10, duration: 1 }] }) });
    const down = async () => { throw new Error('ECONNREFUSED'); };
    const notOk = async () => ({ ok: false, json: async () => ({}) });
    for (const fetchImpl of [absurd, down, notOk]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await routeBetween(BAKAARA, LIDO, { url: 'http://osrm', fetchImpl })).source).toBe('estimate');
    }
  });
});

describe('pickRideDriver — nearest free driver in the right vehicle', () => {
  const now = Date.UTC(2026, 10, 8, 12, 0, 0);
  const fresh = new Date(now - 30_000).toISOString();
  const drv = (id, lat, lng, extra = {}) => ({
    id: BigInt(id), active: true, ready: true, online: true, vehicle: 'bajaj',
    active_orders: 0, active_rides: 0, lat, lng, located_at: fresh, last_assigned_at: null, ...extra,
  });
  const pickup = BAKAARA;

  test('the nearest one gets it', () => {
    const picked = pickRideDriver([drv(1, 2.06, 45.33), drv(2, 2.047, 45.3185), drv(3, 2.05, 45.32)], { pickup, vehicle: 'bajaj', now });
    expect(picked.id).toBe(2n);
    expect(picked.distance_m).toBeLessThan(100);
  });

  test('wrong vehicle, offline, busy, stale or far away drivers are skipped', () => {
    const stale = new Date(now - LOCATION_FRESH_MS - 1000).toISOString();
    const far = { lat: pickup.lat + (RIDE_RADIUS_M + 2000) / 111_000, lng: pickup.lng };
    expect(pickRideDriver([
      drv(1, 2.047, 45.318, { vehicle: 'car' }),
      drv(2, 2.047, 45.318, { online: false }),
      drv(3, 2.047, 45.318, { active_orders: 1 }),
      drv(4, 2.047, 45.318, { active_rides: 1 }),
      drv(5, 2.047, 45.318, { located_at: stale }),
      drv(6, far.lat, far.lng),
      drv(7, null, null, { located_at: null }),
      drv(8, 2.047, 45.318, { ready: false }),
    ], { pickup, vehicle: 'bajaj', now })).toBeNull();
  });

  test('within the same 300 m band, the one who waited longest gets it', () => {
    const picked = pickRideDriver([
      drv(1, 2.0469, 45.3182, { last_assigned_at: '2026-11-08T11:00:00Z' }),
      drv(2, 2.0471, 45.3184, { last_assigned_at: '2026-11-08T09:00:00Z' }),
    ], { pickup, vehicle: 'bajaj', now });
    expect(picked.id).toBe(2n);
  });
});

describe('ride proofs', () => {
  const ride = { kind: 'RIDE', pickup_lat: BAKAARA.lat, pickup_lng: BAKAARA.lng, lat: LIDO.lat, lng: LIDO.lng };

  test('pickup with the rider code needs no review, and is measured from the PICKUP pin', () => {
    const p = buildProof({ step: 'pickup', method: 'code', fix: { ...BAKAARA, accuracy: 10 }, order: ride });
    expect(p.flags).toEqual([]);
    expect(p.distance_m).toBe(0);
  });

  test('pickup without a code is flagged', () => {
    const p = buildProof({ step: 'pickup', method: 'no_code', fix: { ...BAKAARA, accuracy: 10 }, order: ride, note: 'rider has no phone' });
    expect(p.flags).toContain('no_code');
  });

  test('drop-off far from the destination, or with no fix, is flagged — never refused', () => {
    expect(buildProof({ step: 'delivery', method: 'dropoff', fix: { ...BAKAARA, accuracy: 10 }, order: ride }).flags).toContain('far_from_pin');
    expect(buildProof({ step: 'delivery', method: 'dropoff', fix: null, order: ride }).flags).toContain('no_gps');
    expect(buildProof({ step: 'delivery', method: 'dropoff', fix: { ...LIDO, accuracy: 10 }, order: ride }).flags).toEqual([]);
  });

  test('a delivery pickup is still unflagged and measured from the door (unchanged)', () => {
    const p = buildProof({ step: 'pickup', method: 'photo', fix: null, order: { kind: 'DELIVERY', lat: 1, lng: 1 } });
    expect(p.flags).toEqual([]);
  });
});

describe('state machine: release before pickup', () => {
  test('a driver may hand back a job before pickup, not after', () => {
    expect(canTransition('DISPATCHED', 'PAID_UNASSIGNED')).toBe(true);
    expect(canTransition('IN_TRANSIT', 'PAID_UNASSIGNED')).toBe(false);
    expect(canTransition('IN_TRANSIT', 'DISPATCHED')).toBe(false);
  });

  test('chat lines fit the job', () => {
    expect(autoResponse('PAID_UNASSIGNED', 'DISPATCHED', 'RIDE')).toMatch(/pick you up/);
    expect(autoResponse('PAID_UNASSIGNED', 'DISPATCHED', 'DELIVERY')).toMatch(/market/);
    expect(autoResponse('DISPATCHED', 'PAID_UNASSIGNED', 'RIDE')).toMatch(/another one/);
  });
});

describe('WaafiPay (EVC Plus, Zaad, Sahal)', () => {
  const env = { WAAFIPAY_MERCHANT_UID: 'M1', WAAFIPAY_API_USER_ID: '100', WAAFIPAY_API_KEY: 'API-x' };

  test('off unless all three credentials are set; half-set is an error', () => {
    expect(parseWaafiPay({}).enabled).toBe(false);
    expect(parseWaafiPay({}).errors).toEqual([]);
    expect(parseWaafiPay({ WAAFIPAY_API_KEY: 'k' }).errors).toHaveLength(1);
    const ok = parseWaafiPay(env);
    expect(ok.enabled).toBe(true);
    expect(ok.url).toBe(WAAFIPAY_PRODUCTION_URL);
    expect(ok.wallets).toEqual(['evc', 'zaad', 'sahal']);
  });

  test('wallet list can be narrowed to Sahal; eDahab is refused', () => {
    expect(parseWaafiPay({ ...env, WAAFIPAY_WALLETS: 'sahal' }).wallets).toEqual(['sahal']);
    expect(parseWaafiPay({ ...env, WAAFIPAY_WALLETS: 'sahal,edahab' }).errors[0]).toMatch(/edahab/);
  });

  test('payer number is 252XXXXXXXXX; a US number has no wallet', () => {
    expect(payerAccountNo('+252 90 123 4567')).toBe('252901234567');
    expect(payerAccountNo('612345678')).toBe('252612345678');
    expect(payerAccountNo('+12065550100')).toBeNull();
  });

  test('purchase request carries the attempt as referenceId and the order as invoiceId', () => {
    const req = buildPurchaseRequest({
      settings: parseWaafiPay(env), attemptId: 'a-1', orderId: 'o-1', accountNo: '252901234567',
      amount: '3.00', description: 'GuriKaabe ride', now: new Date('2026-11-08T12:00:00Z'),
    });
    expect(req.serviceName).toBe('API_PURCHASE');
    expect(req.timestamp).toBe('2026-11-08 12:00:00.000');
    expect(req.serviceParams).toMatchObject({ merchantUid: 'M1', paymentMethod: 'mwallet_account', payerInfo: { accountNo: '252901234567' } });
    expect(req.serviceParams.transactionInfo).toMatchObject({ referenceId: 'a-1', invoiceId: 'o-1', amount: '3.00', currency: 'USD' });
  });

  test('APPROVED with a transactionId is a payment', () => {
    expect(readPurchaseResponse(200, {
      responseCode: '2001', responseMsg: 'RCS_SUCCESS', params: { state: 'APPROVED', transactionId: '40123456', txAmount: '3.0' },
    })).toEqual({ status: 'approved', reference: '40123456', amount: '3.0' });
  });

  test('approved WITHOUT a transactionId is unknown — no reference, no payment row', () => {
    expect(readPurchaseResponse(200, { responseCode: '2001', params: { state: 'APPROVED' } }).status).toBe('unknown');
  });

  test('5xxx is a refusal; anything unreadable is unknown, never declined', () => {
    expect(readPurchaseResponse(200, { responseCode: '5206', responseMsg: 'RCS_USER_REJECTED' }).status).toBe('declined');
    expect(readPurchaseResponse(502, null).status).toBe('unknown');
    expect(readPurchaseResponse(200, null).status).toBe('unknown');
    expect(readPurchaseResponse(200, { responseCode: '2001', params: { state: 'PENDING' } }).status).toBe('unknown');
  });
});
