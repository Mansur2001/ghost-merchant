// The full customer app (2026-11-11): choosing your driver, technicians, parcels, the
// free-delivery promo, AI Caawiye drafts, public pictures, push words. Pure domain: no
// database, no network.
import { describe, test, expect } from '@jest/globals';
import {
  pickDriver, pickRideDriver, pickTechnician, rideChoices, etaMinutes,
} from '../src/domain/dispatch.js';
import { wantsOffer, offerLive, OFFER_TTL_MS } from '../src/domain/offers.js';
import {
  parcelFeeCents, promoApplies, cleanDetails, deliveryFeeCents, parseTariff, PricingError, DEFAULT_TARIFF,
} from '../src/domain/pricing.js';
import {
  detectIntent, rideDraft, cartDraft, parseModelDraft, draftPrompt,
} from '../src/domain/assistantDraft.js';
import { sniffImage, checkPublicImage, PUBLIC_IMAGE_MAX } from '../src/domain/images.js';
import { buildProof } from '../src/domain/proof.js';
import { autoResponse } from '../src/domain/stateMachine.js';
import { targetsFor, TEXT } from '../src/domain/push.js';
import { choiceCard } from '../src/commands/checkout.js';

const NOW = Date.parse('2026-11-11T10:00:00Z');
const fresh = new Date(NOW - 30 * 1000).toISOString();
const PICKUP = { lat: 2.0469, lng: 45.3182 };
const base = {
  active: true, ready: true, online: true, vehicle: 'bajaj', role: 'driver', trades: [],
  active_orders: 0, active_rides: 0, active_services: 0, has_offer: false, located_at: fresh, last_assigned_at: null,
};
const at = (m) => ({ lat: PICKUP.lat + m / 111320, lng: PICKUP.lng });

describe('dispatch respects roles and open offers', () => {
  test('a technician never gets a ride or a delivery', () => {
    const tech = { ...base, id: 1, role: 'technician', ...at(10) };
    expect(pickRideDriver([tech], { pickup: PICKUP, vehicle: 'bajaj', now: NOW })).toBeNull();
    expect(pickDriver([tech])).toBeNull();
  });
  test('a driver waiting on an offer is skipped by everything else', () => {
    const busy = { ...base, id: 1, has_offer: true, ...at(10) };
    const free = { ...base, id: 2, ...at(2000) };
    expect(pickRideDriver([busy, free], { pickup: PICKUP, vehicle: 'bajaj', now: NOW }).id).toBe(2);
    expect(pickDriver([busy, free]).id).toBe(2);
  });
  test('a driver on a visit (a technician moonlighting) gets no ride', () => {
    const d = { ...base, id: 1, active_services: 1, ...at(10) };
    expect(pickRideDriver([d], { pickup: PICKUP, vehicle: 'bajaj', now: NOW })).toBeNull();
  });
  test('rows from before roles existed still count as drivers', () => {
    const { role, ...old } = { ...base, id: 3, ...at(10) };
    expect(pickRideDriver([old], { pickup: PICKUP, vehicle: 'bajaj', now: NOW }).id).toBe(3);
  });
});

describe('pickTechnician', () => {
  const tech = (id, extra) => ({ ...base, id, role: 'technician', trades: ['plumber'], ...extra });
  test('only the right trade, online, with no visit under way', () => {
    const list = [
      tech(1, { trades: ['electrician'], ...at(10) }),
      tech(2, { online: false, ...at(10) }),
      tech(3, { active_services: 1, ...at(10) }),
      tech(4, at(900)),
    ];
    expect(pickTechnician(list, { trade: 'plumber', site: PICKUP, now: NOW }).id).toBe(4);
  });
  test('nearest band first; a technician with no position still gets work, last', () => {
    const list = [tech(1, { lat: null, lng: null, located_at: null }), tech(2, at(2500)), tech(3, at(400))];
    expect(pickTechnician(list, { trade: 'plumber', site: PICKUP, now: NOW }).id).toBe(3);
    expect(pickTechnician([list[0]], { trade: 'plumber', site: PICKUP, now: NOW }).id).toBe(1);
  });
  test('nobody suitable: null (the visit waits, paid)', () => {
    expect(pickTechnician([], { trade: 'plumber', site: PICKUP, now: NOW })).toBeNull();
  });
});

describe('choosing your driver', () => {
  const drivers = [
    { ...base, id: 1, ...at(1500) }, { ...base, id: 2, ...at(200) }, { ...base, id: 3, ...at(700) },
    { ...base, id: 4, vehicle: 'car', ...at(100) }, { ...base, id: 5, ...at(9000) },
  ];
  test('the list is every free driver of that vehicle in range, nearest first', () => {
    const list = rideChoices(drivers, { pickup: PICKUP, vehicle: 'bajaj', now: NOW });
    expect(list.map((d) => d.id)).toEqual([2, 3, 1]); // 5 is beyond 8 km, 4 is a car
  });
  test('limited, so it is a choice and not a census', () => {
    expect(rideChoices(drivers, { pickup: PICKUP, vehicle: 'bajaj', now: NOW, limit: 2 })).toHaveLength(2);
  });
  test('the card a customer sees: first name, plate, rating, minutes — never a position or a phone', () => {
    const card = choiceCard(
      { id: 7n, name: 'Cabdiraxmaan Ali Yusuf', vehicle: 'bajaj', plate: 'BAJ 123', photo_key: 'drivers/7/x.jpg', distance_m: 1000, lat: 1, lng: 2, msisdn: '+252...' },
      new Map([['7', { avg: 4.9, count: 12 }]]),
    );
    expect(card).toEqual({ id: '7', name: 'Cabdiraxmaan', vehicle: 'bajaj', plate: 'BAJ 123', photo: true, rating: 4.9, ratings: 12, eta_min: 5 });
  });
  test('ETA: road-ish distance at the 18 km/h floor, never zero', () => {
    expect(etaMinutes(10)).toBe(1);
    expect(etaMinutes(3000)).toBe(14);
    expect(etaMinutes(null)).toBeNull();
  });
});

describe('offers', () => {
  test('only a ride with a chosen driver, and only once', () => {
    expect(wantsOffer({ kind: 'RIDE', requested_driver_id: 7n, released_by: [] })).toBe(true);
    expect(wantsOffer({ kind: 'RIDE', requested_driver_id: 7n, released_by: [7n] })).toBe(false);
    expect(wantsOffer({ kind: 'DELIVERY', requested_driver_id: 7n, released_by: [] })).toBe(false);
    expect(wantsOffer({ kind: 'RIDE', requested_driver_id: null, released_by: [] })).toBe(false);
  });
  test('live until the deadline', () => {
    const o = { offer_driver_id: 7n, offer_expires_at: new Date(NOW + 1000) };
    expect(offerLive(o, NOW)).toBe(true);
    expect(offerLive(o, NOW + 2000)).toBe(false);
    expect(offerLive({ offer_driver_id: null, offer_expires_at: null }, NOW)).toBe(false);
    expect(OFFER_TTL_MS).toBe(30000);
  });
});

describe('parcels and the free-delivery promo', () => {
  test('a parcel costs a little more than a delivery, whole 10 cents, minimum applies', () => {
    expect(parcelFeeCents(500)).toBe(150);
    expect(parcelFeeCents(6000)).toBeGreaterThan(deliveryFeeCents(6000));
    expect(parcelFeeCents(6000) % 10).toBe(0);
    expect(() => parcelFeeCents(40000)).toThrow(PricingError);
  });
  test('parcel tariff can be set from env', () => {
    const { tariff, errors } = parseTariff({ PARCEL_BASE: '2', PARCEL_MIN: 'x' });
    expect(tariff.parcel.base).toBe(2);
    expect(errors).toHaveLength(1);
    expect(DEFAULT_TARIFF.parcel.base).toBe(1.5);
  });
  test('the promo waives the fee only when on and over the minimum', () => {
    expect(promoApplies({ enabled: false, minSubtotal: '0' }, 1000)).toBe(false);
    expect(promoApplies({ enabled: true, minSubtotal: '0.00' }, 1)).toBe(true);
    expect(promoApplies({ enabled: true, minSubtotal: '10.00' }, 999)).toBe(false);
    expect(promoApplies({ enabled: true, minSubtotal: '10.00' }, 1000)).toBe(true);
    expect(promoApplies(null, 1000)).toBe(false);
  });
  test('details are the customer\'s words, trimmed and bounded', () => {
    expect(cleanDetails('  a box  ')).toBe('a box');
    expect(() => cleanDetails('x', { what: 'say what is in the parcel' })).toThrow('say what is in the parcel');
    expect(() => cleanDetails('y'.repeat(501))).toThrow(PricingError);
    expect(cleanDetails('', { required: false })).toBeNull();
  });
});

describe('proof for parcels and visits', () => {
  test('a parcel pickup is checked against the sender\'s pin; a visit start against the house', () => {
    const parcel = { kind: 'PARCEL', pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, lat: 2.03, lng: 45.34 };
    expect(buildProof({ step: 'pickup', method: 'photo', fix: { ...at(20), accuracy: 10 }, order: parcel }).flags).toEqual([]);
    expect(buildProof({ step: 'pickup', method: 'photo', fix: null, order: parcel }).flags).toEqual(['no_gps']);
    const visit = { kind: 'SERVICE', lat: PICKUP.lat, lng: PICKUP.lng };
    expect(buildProof({ step: 'pickup', method: 'photo', fix: { ...at(900), accuracy: 10 }, order: visit }).flags).toEqual(['far_from_pin']);
  });
  test('each kind has its own words', () => {
    expect(autoResponse('IN_TRANSIT', 'DELIVERED', 'PARCEL')).toMatch(/parcel/i);
    expect(autoResponse('DISPATCHED', 'IN_TRANSIT', 'SERVICE')).toMatch(/technician/i);
    expect(autoResponse('DISPATCHED', 'PAID_UNASSIGNED', 'SERVICE')).toMatch(/technician/i);
  });
});

describe('AI Caawiye drafts — it fills a screen, never places an order', () => {
  const items = [
    { id: 1, name_en: 'Rice', name_so: 'Bariis' }, { id: 2, name_en: 'Milk', name_so: 'Caano' },
    { id: 3, name_en: 'Camel milk', name_so: 'Caano geel' }, { id: 4, name_en: 'Tomatoes', name_so: 'Yaanyo' },
  ];
  test('requests are drafted; questions go to the FAQ', () => {
    expect(detectIntent('Raashin iiga dalbo')).toBe('order');
    expect(detectIntent('Bajaj ii dalbo')).toBe('ride');
    expect(detectIntent('Goobaha ugu dhow')).toBe('nearby');
    expect(detectIntent('How do I pay for an order?')).toBeNull();
    expect(detectIntent('what does a bajaj cost')).toBeNull();
    expect(detectIntent('sidee wax loo dalbadaa')).toBeNull();
    expect(detectIntent('')).toBeNull();
  });
  test('a ride: vehicle and where to', () => {
    expect(rideDraft('Bajaj ii dalbo ilaa Bakaara fadlan')).toEqual({ type: 'ride', vehicle: 'bajaj', to: 'bakaara' });
    expect(rideDraft('book a taxi to KM4')).toEqual({ type: 'ride', vehicle: 'car', to: 'km4' });
    expect(rideDraft('bajaj')).toEqual({ type: 'ride', vehicle: 'bajaj', to: null });
  });
  test('a cart: real catalog ids, quantities in digits or words, longest name first', () => {
    expect(cartDraft('order 2 rice and milk', items).lines).toEqual([{ itemId: 1, qty: 2 }, { itemId: 2, qty: 1 }]);
    expect(cartDraft('laba bariis iyo caano geel ii keen', items).lines).toEqual([{ itemId: 3, qty: 1 }, { itemId: 1, qty: 2 }]);
    expect(cartDraft('i need 3 tomatoes', items).lines).toEqual([{ itemId: 4, qty: 3 }]);
    expect(cartDraft('rice x4', items).lines).toEqual([{ itemId: 1, qty: 4 }]);
    expect(cartDraft('nothing here', items).lines).toEqual([]);
  });
  test('quantities are capped; nothing outside the catalog survives', () => {
    expect(cartDraft('99 rice', items).lines).toEqual([{ itemId: 1, qty: 50 }]);
    expect(parseModelDraft('{"lines":[{"id":1,"qty":2},{"id":999,"qty":1},{"id":2,"qty":-3}]}', items))
      .toEqual([{ itemId: 1, qty: 2 }, { itemId: 2, qty: 1 }]);
    expect(parseModelDraft('I refunded you', items)).toEqual([]);
    expect(parseModelDraft('Sure! {"lines":[{"id":4,"qty":200}]}', items)).toEqual([{ itemId: 4, qty: 50 }]);
  });
  test('the model sees names and ids only — no prices, nobody\'s data', () => {
    const p = draftPrompt([{ id: 1, name_en: 'Rice', name_so: 'Bariis', unit_en: '5 kg', price: '5.00' }]);
    expect(p).toContain('1: Rice (5 kg) / Bariis');
    expect(p).not.toContain('5.00');
  });
});

describe('public pictures: the type comes from the bytes', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
  test('JPEG, PNG and WebP are recognised', () => {
    expect(sniffImage(jpeg).ext).toBe('jpg');
    expect(sniffImage(png).ext).toBe('png');
    expect(sniffImage(webp).ext).toBe('webp');
  });
  test('an SVG or HTML file called image/png is refused', () => {
    expect(checkPublicImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')).error).toMatch(/JPEG/);
    expect(checkPublicImage(Buffer.from('<!doctype html><script>alert(1)</script>')).error).toMatch(/JPEG/);
    expect(checkPublicImage(Buffer.alloc(0)).error).toBeTruthy();
    expect(checkPublicImage(Buffer.concat([jpeg, Buffer.alloc(PUBLIC_IMAGE_MAX)])).error).toMatch(/too big/);
  });
});

describe('push words for the new jobs', () => {
  test('an offer buzzes the chosen driver; a closed one buzzes nobody', () => {
    const order = { id: 'o1', user_id: 5, driver_id: null, kind: 'RIDE', status: 'PAID_UNASSIGNED' };
    expect(targetsFor({ name: 'driver.offered', payload: { orderId: 'o1', driverId: '9' } }, order))
      .toEqual([expect.objectContaining({ to: { role: 'driver', id: '9' }, kind: 'offer' })]);
    expect(targetsFor({ name: 'driver.offered', payload: { orderId: 'o1', driverId: '9', closed: 'expired' } }, order)).toEqual([]);
  });
  test('a parcel and a visit get their own words; a technician hears "new visit"', () => {
    const visit = { id: 'o2', user_id: 5, driver_id: 4n, kind: 'SERVICE', status: 'DISPATCHED' };
    const out = targetsFor({ name: 'order.state_changed', payload: { orderId: 'o2', from: 'PAID_UNASSIGNED', to: 'DISPATCHED' } }, visit);
    expect(out.map((x) => x.kind).sort()).toEqual(['dispatched_service', 'new_visit']);
    const parcel = { id: 'o3', user_id: 5, driver_id: null, kind: 'PARCEL', status: 'DELIVERED' };
    expect(targetsFor({ name: 'order.state_changed', payload: { orderId: 'o3', from: 'IN_TRANSIT', to: 'DELIVERED' } }, parcel)[0].kind).toBe('delivered_parcel');
  });
  test('every new text exists in both languages', () => {
    for (const k of ['offer', 'new_visit', 'extra_quote', 'submission_live', 'topup_rejected', 'op_topup', 'delivered_parcel', 'in_transit_service']) {
      expect(TEXT.en[k]).toBeDefined();
      expect(TEXT.so[k]).toBeDefined();
    }
    expect(Object.keys(TEXT.so).sort()).toEqual(Object.keys(TEXT.en).sort());
  });
});
