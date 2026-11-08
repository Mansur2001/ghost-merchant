// Checkout: price a job on the server, then create it. The client sends WHAT it wants (items
// and quantities, a pickup and a destination, a vehicle) and never what it costs. `quote`
// writes nothing — it is the same calculation `placeOrder` runs, so the price on the screen
// and the price on the order can't drift apart.
//
//   DELIVERY  { kind, cart: { lines: [{ itemId, qty }], custom?: { text, budget } },
//               dropoff: { lat, lng } | { placeId }, pickupPlaceId?, landmark, phone }
//             fee = market -> door distance. No market chosen: the nearest one to the door.
//   RIDE      { kind, vehicle, pickup: {lat,lng}|{placeId}, dropoff: {lat,lng}|{placeId},
//               pickupNote?, landmark?, phone }
//             fare = pickup -> destination distance, per vehicle.
//
// `expectedTotal` (what the customer saw) is checked against the fresh price: if a price
// changed in between, the order is refused with the new quote rather than charging an amount
// nobody agreed to.
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';
import {
  priceCart, rideFareCents, deliveryFeeCents, fromCents, toCents, PricingError, VEHICLES,
} from '../domain/pricing.js';
import { parsePoint, inServiceArea, nearestPlace, distanceMeters } from '../domain/geo.js';
import { pickRideDriver, LOCATION_FRESH_MS } from '../domain/dispatch.js';
import { routeBetween } from '../routing/route.js';
import { getActiveItems, getPlaces, getPlace } from '../queries/catalog.js';
import { createOrder } from './orders.js';
import { isUuid } from '../domain/ids.js';

const MIN_RIDE_M = 200;

// A point from { lat, lng } or { placeId }. Returns { lat, lng, label } or throws.
async function resolvePoint(raw, what) {
  if (raw && raw.placeId != null) {
    const place = await getPlace(raw.placeId);
    if (!place) throw new PricingError(`choose the ${what} again — that place is not on the list`);
    return { lat: place.lat, lng: place.lng, label: place.name_en, placeId: place.id };
  }
  const p = parsePoint(raw);
  if (!p) throw new PricingError(`set the ${what} on the map`);
  if (!inServiceArea(p)) throw new PricingError(`the ${what} is outside the area we serve`);
  return { ...p, label: null };
}

// How many free drivers of each vehicle are near the pickup: shown before paying, so nobody
// pays for a ride that has no driver to take it. Counts only — never positions.
async function availableNear(pickup) {
  const since = new Date(Date.now() - LOCATION_FRESH_MS);
  const candidates = await prisma.$queryRaw`
    SELECT d.id, d.active, d.online, d.vehicle, (d.pin_set_at IS NOT NULL) AS ready, d.last_assigned_at,
           l.lat, l.lng, l.updated_at AS located_at,
           COUNT(o.id) FILTER (WHERE o.kind = 'DELIVERY')::int AS active_orders,
           COUNT(o.id) FILTER (WHERE o.kind = 'RIDE')::int AS active_rides
      FROM drivers d
      JOIN driver_locations l ON l.driver_id = d.id AND l.updated_at >= ${since}
      LEFT JOIN orders o ON o.driver_id = d.id AND o.status IN ('DISPATCHED', 'IN_TRANSIT')
     WHERE d.active AND d.online
     GROUP BY d.id, l.lat, l.lng, l.updated_at
  `;
  const out = {};
  for (const vehicle of VEHICLES) {
    let n = 0;
    const pool = [...candidates];
    // pickRideDriver returns one; count by removing each pick until none is left.
    for (;;) {
      const d = pickRideDriver(pool, { pickup, vehicle });
      if (!d) break;
      n += 1;
      pool.splice(pool.findIndex((c) => String(c.id) === String(d.id)), 1);
    }
    out[vehicle] = n;
  }
  return out;
}

async function quoteRide(body, tariff) {
  const pickup = await resolvePoint(body.pickup, 'pickup');
  const dropoff = await resolvePoint(body.dropoff, 'destination');
  if (distanceMeters(pickup, dropoff) < MIN_RIDE_M) {
    throw new PricingError('the pickup and the destination are too close together');
  }
  const route = await routeBetween(pickup, dropoff);
  const available = await availableNear(pickup);
  const options = VEHICLES.map((vehicle) => {
    const fare = rideFareCents(route.meters, vehicle, tariff);
    return { vehicle, fee: fromCents(fare), total: fromCents(fare), available: available[vehicle] };
  });
  return {
    kind: 'RIDE', pickup, dropoff, distance_m: route.meters, minutes: route.minutes,
    route_source: route.source, options,
  };
}

async function quoteDelivery(body, tariff) {
  const cart = body.cart || {};
  const ids = Array.isArray(cart.lines) ? cart.lines.map((l) => l?.itemId) : [];
  const { items, subtotalCents } = priceCart(cart, await getActiveItems(ids));
  const dropoff = await resolvePoint(body.dropoff, 'delivery point');

  let pickup = null;
  if (body.pickupPlaceId != null) {
    const place = await getPlace(body.pickupPlaceId);
    if (!place || place.kind !== 'market') throw new PricingError('choose the market again');
    pickup = { lat: place.lat, lng: place.lng, label: place.name_en, placeId: place.id };
  } else {
    const near = nearestPlace(dropoff, await getPlaces({ kind: 'market' }));
    if (near) pickup = { lat: near.place.lat, lng: near.place.lng, label: near.place.name_en, placeId: near.place.id };
  }
  const route = pickup ? await routeBetween(pickup, dropoff) : { meters: 0, minutes: null, source: 'none' };
  const fee = deliveryFeeCents(route.meters, tariff);
  return {
    kind: 'DELIVERY', pickup, dropoff, items, distance_m: pickup ? route.meters : null,
    minutes: route.minutes, route_source: route.source,
    subtotal: fromCents(subtotalCents), fee: fromCents(fee), total: fromCents(subtotalCents + fee),
  };
}

export async function quote(body, { tariff = config.pricing.tariff } = {}) {
  const kind = body?.kind;
  if (kind === 'RIDE') return quoteRide(body, tariff);
  if (kind === 'DELIVERY') return quoteDelivery(body, tariff);
  throw new PricingError('kind must be RIDE or DELIVERY');
}

export async function placeOrder({ userId, body, tariff = config.pricing.tariff }) {
  // A retry of an order that already landed returns it, before re-pricing: a price edited in
  // between must not turn "your order is placed" into "the price changed".
  if (body.id != null && isUuid(body.id)) {
    const existing = await prisma.order.findUnique({ where: { id: body.id } });
    if (existing) {
      if (existing.user_id !== userId) throw new PricingError('id already in use');
      return { order: existing, created: false };
    }
  }
  const q = await quote(body, { tariff });
  let total;
  let subtotal;
  let fee;
  let vehicle = null;
  if (q.kind === 'RIDE') {
    const option = q.options.find((o) => o.vehicle === body.vehicle);
    if (!option) throw new PricingError('choose bajaj or car');
    total = option.total;
    subtotal = '0.00';
    fee = option.fee;
    vehicle = option.vehicle;
  } else {
    ({ total, subtotal, fee } = q);
  }
  if (body.expectedTotal != null && toCents(body.expectedTotal) !== toCents(total)) {
    const err = new PricingError(`the price changed to $${total} — check and confirm again`, 409);
    err.quote = q;
    throw err;
  }

  const note = typeof body.pickupNote === 'string' ? body.pickupNote.trim().slice(0, 200) : '';
  const landmarkIn = typeof body.landmark === 'string' ? body.landmark.trim().slice(0, 300) : '';
  // Where the job ends, in words. Mandatory for a delivery (the driver reads it at the door);
  // a ride can use the chosen place's name.
  const landmark = landmarkIn || q.dropoff.label || (q.kind === 'RIDE' ? 'Pinned destination' : '');
  const pickupText = [q.pickup?.label, note].filter(Boolean).join(' — ') || (q.kind === 'RIDE' ? 'Pinned pickup' : null);

  return createOrder({
    id: body.id,
    userId,
    contactPhone: body.phone,
    items: q.kind === 'RIDE' ? [] : q.items,
    totalAmount: total,
    lat: q.dropoff.lat,
    lng: q.dropoff.lng,
    landmark,
    kind: q.kind,
    pickup: q.pickup ? { lat: q.pickup.lat, lng: q.pickup.lng, text: pickupText } : null,
    vehicle,
    distanceM: q.distance_m,
    subtotal,
    fee,
  });
}
