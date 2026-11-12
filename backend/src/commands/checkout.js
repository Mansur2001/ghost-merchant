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
//             fare = pickup -> destination distance, per vehicle. `driverId` (optional) is the
//             driver the customer chose from the quote's list: offered the ride first.
//   PARCEL    { kind, pickup, dropoff, details, recipientPhone, pickupNote?, landmark, phone }
//             fee = sender's door -> receiver's door distance (domain/pricing.js parcelFeeCents).
//   SERVICE   { kind, trade, dropoff (where the visit is), details, landmark, phone }
//             fee = the trade's visit fee. Extra work is quoted later by the technician.
//
// The admin's free-delivery promo (commands/settings.js) can waive a DELIVERY fee.
//
// `expectedTotal` (what the customer saw) is checked against the fresh price: if a price
// changed in between, the order is refused with the new quote rather than charging an amount
// nobody agreed to.
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';
import {
  priceCart, rideFareCents, deliveryFeeCents, parcelFeeCents, promoApplies, cleanDetails,
  fromCents, toCents, PricingError, VEHICLES,
} from '../domain/pricing.js';
import { parsePoint, inServiceArea, nearestPlace, distanceMeters } from '../domain/geo.js';
import { rideChoices, pickTechnician, etaMinutes } from '../domain/dispatch.js';
import { dispatchCandidates } from './dispatch.js';
import { getSetting } from './settings.js';
import { driverRatings } from '../queries/ratings.js';
import { routeBetween } from '../routing/route.js';
import { getActiveItems, getPlaces, getPlace, getTrade } from '../queries/catalog.js';
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

// The free drivers of each vehicle near the pickup: a COUNT, and the few the customer may
// choose from (first name, photo, plate, rating, minutes away). Never a position: a list of
// where drivers are is a map of where to find them.
export function choiceCard(d, ratings) {
  const r = ratings.get(String(d.id));
  return {
    id: String(d.id),
    name: String(d.name || '').trim().split(/\s+/)[0],
    vehicle: d.vehicle,
    plate: d.plate || null,
    photo: Boolean(d.photo_key),
    rating: r ? r.avg : null,
    ratings: r ? r.count : 0,
    eta_min: etaMinutes(d.distance_m),
  };
}

async function availableNear(pickup) {
  const candidates = await dispatchCandidates(prisma);
  const extra = await prisma.driver.findMany({
    where: { id: { in: candidates.map((c) => c.id) } }, select: { id: true, plate: true, photo_key: true },
  });
  const byId = new Map(extra.map((d) => [String(d.id), d]));
  const pool = candidates.map((c) => ({ ...c, ...byId.get(String(c.id)) }));
  const out = {};
  const chosen = [];
  for (const vehicle of VEHICLES) {
    const all = rideChoices(pool, { pickup, vehicle, limit: 50 });
    out[vehicle] = { count: all.length, list: all.slice(0, 5) };
    chosen.push(...out[vehicle].list);
  }
  const ratings = await driverRatings(chosen.map((d) => d.id));
  for (const vehicle of VEHICLES) out[vehicle].list = out[vehicle].list.map((d) => choiceCard(d, ratings));
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
    return {
      vehicle, fee: fromCents(fare), total: fromCents(fare),
      available: available[vehicle].count, drivers: available[vehicle].list,
    };
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
  const fullFee = deliveryFeeCents(route.meters, tariff);
  const promo = promoApplies(await getSetting('free_delivery'), subtotalCents) ? 'free_delivery' : null;
  const fee = promo ? 0 : fullFee;
  return {
    kind: 'DELIVERY', pickup, dropoff, items, distance_m: pickup ? route.meters : null,
    minutes: route.minutes, route_source: route.source,
    subtotal: fromCents(subtotalCents), fee: fromCents(fee), total: fromCents(subtotalCents + fee),
    promo, fee_before: promo ? fromCents(fullFee) : null,
  };
}

async function quoteParcel(body, tariff) {
  const pickup = await resolvePoint(body.pickup, 'pickup');
  const dropoff = await resolvePoint(body.dropoff, 'drop-off');
  if (distanceMeters(pickup, dropoff) < MIN_RIDE_M) {
    throw new PricingError('the two addresses are too close together');
  }
  const route = await routeBetween(pickup, dropoff);
  const fee = parcelFeeCents(route.meters, tariff);
  return {
    kind: 'PARCEL', pickup, dropoff, distance_m: route.meters, minutes: route.minutes, route_source: route.source,
    subtotal: '0.00', fee: fromCents(fee), total: fromCents(fee),
  };
}

async function quoteService(body) {
  const trade = await getTrade(body.trade);
  if (!trade) throw new PricingError('choose the kind of work again');
  const dropoff = await resolvePoint(body.dropoff, 'place for the visit');
  const candidates = await dispatchCandidates(prisma);
  let available = 0;
  const pool = [...candidates];
  for (;;) {
    const t = pickTechnician(pool, { trade: trade.slug, site: dropoff });
    if (!t) break;
    available += 1;
    pool.splice(pool.findIndex((c) => String(c.id) === String(t.id)), 1);
  }
  const fee = toCents(trade.visit_fee);
  return {
    kind: 'SERVICE', dropoff, available,
    trade: { slug: trade.slug, name_en: trade.name_en, name_so: trade.name_so, icon: trade.icon },
    subtotal: '0.00', fee: fromCents(fee), total: fromCents(fee),
  };
}

export async function quote(body, { tariff = config.pricing.tariff } = {}) {
  const kind = body?.kind;
  if (kind === 'RIDE') return quoteRide(body, tariff);
  if (kind === 'DELIVERY') return quoteDelivery(body, tariff);
  if (kind === 'PARCEL') return quoteParcel(body, tariff);
  if (kind === 'SERVICE') return quoteService(body);
  throw new PricingError('kind must be RIDE, DELIVERY, PARCEL or SERVICE');
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
  let requestedDriverId = null;
  if (q.kind === 'RIDE') {
    const option = q.options.find((o) => o.vehicle === body.vehicle);
    if (!option) throw new PricingError('choose bajaj or car');
    total = option.total;
    subtotal = '0.00';
    fee = option.fee;
    vehicle = option.vehicle;
    // The driver must still be on the list the customer would see now: free, near, online.
    if (body.driverId != null && body.driverId !== '') {
      const pick = option.drivers.find((d) => d.id === String(body.driverId));
      if (!pick) {
        const err = new PricingError('that driver is no longer free — choose again', 409);
        err.quote = q;
        throw err;
      }
      requestedDriverId = pick.id;
    }
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
  const pickupText = [q.pickup?.label, note].filter(Boolean).join(' — ')
    || ({ RIDE: 'Pinned pickup', PARCEL: 'Pinned pickup' }[q.kind] ?? null);
  let details = null;
  let recipientPhone = null;
  if (q.kind === 'PARCEL') {
    details = cleanDetails(body.details, { what: 'say what is in the parcel' });
    if (!body.recipientPhone) throw new PricingError('enter the phone of the person receiving it');
    recipientPhone = body.recipientPhone;
  }
  if (q.kind === 'SERVICE') details = cleanDetails(body.details, { what: 'describe the problem' });

  return createOrder({
    id: body.id,
    userId,
    contactPhone: body.phone,
    items: q.kind === 'DELIVERY' ? q.items : [],
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
    requestedDriverId,
    trade: q.kind === 'SERVICE' ? q.trade.slug : null,
    details,
    recipientPhone,
    promo: q.promo || null,
  });
}
