// Idempotent, re-runnable dev seed. Running it any number of times converges the database
// to the SAME known state (TRUNCATE ... RESTART IDENTITY, then insert) — so you can reset to
// a full, workflow-complete dataset whenever the data drifts. Covers EVERY order state plus
// a customer's "I've paid" claim and seeded photos, so all three PWAs have something real to work with.
//
//   docker compose exec backend npm run seed
//
// Refuses to run unless NODE_ENV is explicitly development/test, and refuses to wipe data it
// did not create without SEED_CONFIRM=wipe-local-data (rules in db/seedSafety.js).
import { prisma } from './prisma.js';
import { hashSecret } from '../middleware/auth.js';
import { putObject } from '../storage/objectStore.js';
import { SEED_OPERATORS, SEED_DRIVERS, SEED_CUSTOMERS } from './seedFixtures.js';
import { seedRefusal } from './seedSafety.js';
import { buildProof } from '../domain/proof.js';
import { ensureStarterCatalog } from './starterCatalog.js';
import { priceCart, deliveryFeeCents, rideFareCents, parcelFeeCents, fromCents } from '../domain/pricing.js';
import { estimateRoadMeters } from '../domain/geo.js';

// Rows this seed would never have created: evidence that real (or at least someone's) data
// lives here. Checked BEFORE the truncate, outside its transaction.
async function countNonSeedRows() {
  const [users, operators, drivers, accessRequests] = await Promise.all([
    prisma.user.count({ where: { OR: [{ phone_number: null }, { phone_number: { notIn: SEED_CUSTOMERS } }] } }),
    prisma.operator.count({ where: { username: { notIn: SEED_OPERATORS.map((o) => o.username) } } }),
    prisma.driver.count({ where: { msisdn: { notIn: SEED_DRIVERS.map((d) => d.msisdn) } } }),
    prisma.accessRequest.count(),
  ]);
  return { customers: users, operators, drivers, 'access requests': accessRequests };
}

// A tiny self-describing SVG so seeded photos render as real images in the gallery.
const svgPhoto = (label, bg) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">` +
      `<rect width="100%" height="100%" fill="${bg}"/>` +
      `<text x="50%" y="50%" font-family="sans-serif" font-size="20" fill="#1a1400" ` +
      `text-anchor="middle" dominant-baseline="middle">${label}</text></svg>`
  );

// The state path each order has walked, used to synthesize a realistic audit trail.
const PATHS = {
  PENDING_PAYMENT: ['PENDING_PAYMENT'],
  PAID_UNASSIGNED: ['PENDING_PAYMENT', 'PAID_UNASSIGNED'],
  DISPATCHED: ['PENDING_PAYMENT', 'PAID_UNASSIGNED', 'DISPATCHED'],
  IN_TRANSIT: ['PENDING_PAYMENT', 'PAID_UNASSIGNED', 'DISPATCHED', 'IN_TRANSIT'],
  DELIVERED: ['PENDING_PAYMENT', 'PAID_UNASSIGNED', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED'],
  FAILED_REFUND: ['PENDING_PAYMENT', 'FAILED_REFUND'],
};

// Named operator accounts (P0 #5). Two of them on purpose: the whole point of the change is
// that order_events.actor can tell two people apart, and a one-row roster can't demo that.
const OPERATORS = SEED_OPERATORS;
// What each seeded driver drives, whether they are online, and where they are. Amina (busy with
// deliveries) and Bashir (car, free) start OFFLINE, so the paid order stays "waiting for a
// driver" until someone goes online — the way a shift starts. Cali (bajaj) has a rider.
// Daahir is a technician (plumber, electrician) on a visit, with extra work quoted.
const DRIVER_STATE = [
  { vehicle: 'bajaj', online: false, at: { lat: 2.0472, lng: 45.3190 }, plate: 'BAJ 123' },
  { vehicle: 'car', online: false, at: { lat: 2.0340, lng: 45.3405 }, plate: 'MOG 4521' },
  { vehicle: 'bajaj', online: true, at: { lat: 2.0301, lng: 45.3060 }, plate: 'BAJ 777' },
  { vehicle: 'moto', online: true, at: { lat: 2.0390, lng: 45.3180 }, role: 'technician', trades: ['plumber', 'electrician'] },
];
const DRIVERS = SEED_DRIVERS.map((d, i) => ({ ...d, ...DRIVER_STATE[i] }));
const USERS = SEED_CUSTOMERS;

// driverIdx is a 1-based index into DRIVERS (null = unassigned).
const ORDERS = [
  { status: 'PENDING_PAYMENT', phone: '+252612345678', amount: '7.25', driverIdx: null,
    landmark: 'Green house next to the yellow pharmacy', lat: 2.0469, lng: 45.3182,
    items: [{ text: '2kg rice, 1L cooking oil, 6 eggs' }], refPhoto: true },
  { status: 'PAID_UNASSIGNED', phone: '+252651234567', amount: '4.50', driverIdx: null,
    landmark: 'Blue gate opposite Bakaara stall 12', lat: 2.0421, lng: 45.3301,
    items: [{ text: 'Sugar 1kg, tea leaves, powdered milk' }] },
  { status: 'DISPATCHED', phone: '+252771234567', amount: '6.00', driverIdx: 1,
    landmark: 'Near the big mosque, red door', lat: 2.0388, lng: 45.3255,
    items: [{ text: 'Tomatoes, onions, coriander, 1kg beef' }] },
  { status: 'IN_TRANSIT', phone: '+252612345678', amount: '9.75', driverIdx: 1,
    landmark: 'White building, 2nd floor, green balcony', lat: 2.0502, lng: 45.3190,
    items: [{ text: 'Flour 5kg, yeast, cooking oil 2L' }] },
  { status: 'DELIVERED', phone: '+252651234567', amount: '3.20', driverIdx: 2,
    landmark: 'Corner shop with blue awning', lat: 2.0455, lng: 45.3277,
    items: [{ text: 'Bread x3, butter, jam' }], proofPhoto: true },
  { status: 'FAILED_REFUND', phone: '+252771234567', amount: '12.00', driverIdx: null,
    landmark: 'Market entrance gate 3', lat: 2.0410, lng: 45.3300,
    items: [{ text: 'Bulk order: 25kg rice sack' }] },
  // Rides: fare from the tariff, pickup -> destination.
  { kind: 'RIDE', status: 'DISPATCHED', phone: '+252771234567', driverIdx: 3, vehicle: 'bajaj',
    pickup: { lat: 2.0295, lng: 45.3045, text: 'KM4 junction — outside the pharmacy' },
    landmark: 'Lido Beach', lat: 2.0570, lng: 45.3625, items: [] },
  { kind: 'RIDE', status: 'PENDING_PAYMENT', phone: '+252651234567', driverIdx: null, vehicle: 'car',
    pickup: { lat: 2.0480, lng: 45.3288, text: 'Mogadishu Stadium' },
    landmark: 'Aden Adde Airport', lat: 2.0144, lng: 45.3047, items: [] },
  // Finished rides with ratings, so "choose your driver" shows stars.
  { kind: 'RIDE', status: 'DELIVERED', phone: '+252612345678', driverIdx: 3, vehicle: 'bajaj', rating: 5,
    pickup: { lat: 2.0320, lng: 45.3100, text: 'Hodan' },
    landmark: 'Bakaara Market', lat: 2.0469, lng: 45.3182, items: [] },
  { kind: 'RIDE', status: 'DELIVERED', phone: '+252771234567', driverIdx: 1, vehicle: 'bajaj', rating: 4,
    pickup: { lat: 2.0150, lng: 45.2950, text: 'Wadajir' },
    landmark: 'KM4 junction', lat: 2.0295, lng: 45.3045, items: [] },
  // A parcel being collected, and a plumber's visit under way with extra work quoted.
  { kind: 'PARCEL', status: 'DISPATCHED', phone: '+252612345678', driverIdx: 1,
    pickup: { lat: 2.0320, lng: 45.3100, text: 'Hodan — blue gate' },
    details: 'Documents in an envelope', recipient: '+252651234567',
    landmark: 'Hamar Weyne, shop 4', lat: 2.0336, lng: 45.3420, items: [] },
  { kind: 'SERVICE', status: 'IN_TRANSIT', phone: '+252612345678', driverIdx: 4, trade: 'plumber', fee: '5.00',
    details: 'Kitchen tap is leaking', extra: { details: 'New tap and fitting', amount: '8.00' },
    landmark: 'Green house next to the yellow pharmacy', lat: 2.0469, lng: 45.3182, items: [] },
];

// The first pending delivery is a priced cart from the starter catalog (the new checkout);
// the rest keep the legacy typed-request shape older app builds created.
// By name: ids follow the starter's order, which grows.
const SEED_CART_NAMES = [['Tomatoes', 2], ['Milk', 1], ['Rice', 1], ['Cooking oil', 1]];

async function seed() {
  const refusal = seedRefusal({
    nodeEnv: process.env.NODE_ENV,
    nonSeedRows: await countNonSeedRows(),
    confirm: process.env.SEED_CONFIRM,
  });
  if (refusal) {
    console.error(`Refusing to seed (this TRUNCATEs every domain table): ${refusal}`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const photoJobs = []; // { orderId, kind, ... } to upload after the DB commit

  await prisma.$transaction(async (tx) => {
    // Reset to a clean slate with deterministic sequences. Raw because Prisma has no
    // TRUNCATE ... RESTART IDENTITY CASCADE — and deleteMany() in dependency order would be
    // both slower and easy to get subtly wrong as the schema grows.
    await tx.$executeRawUnsafe(`
      TRUNCATE outbox, otp_codes, staff_invites, order_photos, order_events, messages, transactions,
               refunds, access_requests, order_proofs, delivery_handoffs, audit_log, payment_attempts,
               wallet_entries, wallet_withdrawals, wallet_accounts, bug_reports, push_subscriptions,
               ratings, catalog_submissions, driver_locations, orders, drivers, users, operators, catalog_items, catalog_categories, places, trades, app_settings
      RESTART IDENTITY CASCADE
    `);
    await ensureStarterCatalog(tx);
    const allItems = await tx.catalogItem.findMany();
    const catalog = new Map(allItems.map((i) => [i.id, i]));
    const SEED_CART = {
      lines: SEED_CART_NAMES.map(([n, qty]) => ({ itemId: allItems.find((i) => i.name_en === n).id, qty })),
    };
    const bakaara = await tx.place.findFirst({ where: { name_en: 'Bakaara Market' } });

    const userIds = {};
    for (const phone_number of USERS) {
      // eslint-disable-next-line no-await-in-loop
      userIds[phone_number] = (await tx.user.create({ data: { phone_number }, select: { id: true } })).id;
    }

    await tx.operator.createMany({
      data: OPERATORS.map((o) => ({
        username: o.username,
        display_name: o.displayName,
        password_hash: hashSecret(o.password),
        is_admin: o.isAdmin,
        created_by: 'system:seed',
      })),
    });

    const driverIds = [];
    for (const d of DRIVERS) {
      // eslint-disable-next-line no-await-in-loop
      const created = await tx.driver.create({
        data: {
          name: d.name, msisdn: d.msisdn, pin_hash: hashSecret(d.pin), pin_set_at: new Date(),
          vehicle: d.vehicle, online: d.online, plate: d.plate || null,
          role: d.role || 'driver', trades: d.trades || [],
        },
        select: { id: true },
      });
      driverIds.push(created.id);
      // eslint-disable-next-line no-await-in-loop
      await tx.driverLocation.create({ data: { driver_id: created.id, ...d.at, accuracy_m: 15 } });
    }

    let receiptSeq = 1;
    for (const o of ORDERS) {
      const driverId = o.driverIdx ? driverIds[o.driverIdx - 1] : null;
      // Price the new-style jobs exactly as checkout would.
      let priced = {};
      if (o.kind === 'RIDE') {
        const meters = estimateRoadMeters(o.pickup, o);
        const fare = fromCents(rideFareCents(meters, o.vehicle));
        o.amount = fare;
        priced = {
          kind: 'RIDE', vehicle: o.vehicle, distance_m: meters, subtotal: '0.00', fee: fare,
          pickup_lat: o.pickup.lat, pickup_lng: o.pickup.lng, pickup_text: o.pickup.text,
        };
      } else if (o.kind === 'PARCEL') {
        const meters = estimateRoadMeters(o.pickup, o);
        const fee = fromCents(parcelFeeCents(meters));
        o.amount = fee;
        priced = {
          kind: 'PARCEL', distance_m: meters, subtotal: '0.00', fee,
          pickup_lat: o.pickup.lat, pickup_lng: o.pickup.lng, pickup_text: o.pickup.text,
          details: o.details, recipient_phone: o.recipient,
        };
      } else if (o.kind === 'SERVICE') {
        o.amount = o.fee;
        priced = { kind: 'SERVICE', subtotal: '0.00', fee: o.fee, trade: o.trade, details: o.details };
      } else if (o === ORDERS[0]) {
        const { items, subtotalCents } = priceCart(SEED_CART, catalog);
        const meters = estimateRoadMeters(bakaara, o);
        const fee = deliveryFeeCents(meters);
        o.items = items;
        o.amount = fromCents(subtotalCents + fee);
        priced = {
          subtotal: fromCents(subtotalCents), fee: fromCents(fee), distance_m: meters,
          pickup_lat: bakaara.lat, pickup_lng: bakaara.lng, pickup_text: bakaara.name_en,
        };
      }
      // eslint-disable-next-line no-await-in-loop
      const order = await tx.order.create({
        data: {
          user_phone: o.phone,
          user_id: userIds[o.phone],
          status: o.status,
          total_amount: o.amount,
          items: o.items,
          lat: o.lat,
          lng: o.lng,
          landmark_text: o.landmark,
          driver_id: driverId,
          ...priced,
        },
        select: { id: true },
      });
      const orderId = order.id;

      // Synthesize the audit trail for the path this order has walked.
      const path = PATHS[o.status];
      let from = null;
      for (const to of path) {
        const actor = ['DISPATCHED', 'IN_TRANSIT', 'DELIVERED'].includes(to) && driverId
          ? `driver:${driverId}` : 'system';
        // eslint-disable-next-line no-await-in-loop
        await tx.orderEvent.create({
          data: { order_id: orderId, from_status: from, to_status: to, actor, note: 'seed' },
        });
        from = to;
      }

      // A couple of chat messages so the thread isn't empty.
      const messages = [{
        order_id: orderId, sender: 'user',
        body: { RIDE: 'I am waiting outside.', PARCEL: 'Please call the receiver before you go.', SERVICE: 'The tap is under the sink.' }[o.kind]
          || o.items.map((i) => i.text).join(', '),
      }];
      if (o.status !== 'PENDING_PAYMENT') {
        messages.push({
          order_id: orderId,
          sender: 'system',
          body: 'Payment confirmed. We are coordinating your delivery.',
        });
      }
      // eslint-disable-next-line no-await-in-loop
      await tx.message.createMany({ data: messages });

      // Matched receipt for every order that has been paid.
      if (o.status !== 'PENDING_PAYMENT' && o.status !== 'FAILED_REFUND') {
        // eslint-disable-next-line no-await-in-loop
        await tx.transaction.create({
          data: {
            order_id: orderId,
            telecom_receipt_id: `SEED-RCPT-${receiptSeq++}`,
            sender_msisdn: o.phone,
            amount: o.amount,
            matched: true,
            provider: 'manual',
            sender_name: 'operator:seed',
          },
        });
      }

      // An outstanding refund on the failed order, so the reconciliation queue has a real
      // item: money we owe a customer that has not gone back yet.
      if (o.status === 'FAILED_REFUND') {
        // eslint-disable-next-line no-await-in-loop
        await tx.refund.create({
          data: {
            order_id: orderId,
            amount: o.amount,
            reason: 'seed: order failed after payment',
            status: 'owed',
            created_by: 'system:seed',
          },
        });
      }

      // Delivery code and proof for the steps this order has passed (domain/proof.js). Fixed
      // codes, so every run converges to the same state and screenshots don't change.
      // eslint-disable-next-line no-await-in-loop
      await tx.deliveryHandoff.create({
        data: {
          order_id: orderId,
          code: String(4821 + ORDERS.indexOf(o) * 1111).slice(-4),
          verified_at: o.status === 'DELIVERED' ? new Date() : null,
        },
      });
      const pastPickup = o.kind !== 'RIDE' && ['IN_TRANSIT', 'DELIVERED'].includes(o.status);
      const near = { lat: o.lat + 0.0004, lng: o.lng + 0.0003, accuracy: 18 };
      if (pastPickup) {
        photoJobs.push({ orderId, kind: 'pickup_proof', label: '🛍️ Items', bg: '#e6c65c' });
        // eslint-disable-next-line no-await-in-loop
        await tx.orderProof.create({
          data: { order_id: orderId, actor: `driver:${driverId}`, ...buildProof({ step: 'pickup', method: 'photo', fix: near, order: o }) },
        });
      }
      if (o.status === 'DELIVERED') {
        // eslint-disable-next-line no-await-in-loop
        await tx.orderProof.create({
          data: { order_id: orderId, actor: `driver:${driverId}`, ...buildProof({ step: 'delivery', method: 'code', fix: near, order: o }) },
        });
      }

      if (o.rating) {
        // eslint-disable-next-line no-await-in-loop
        await tx.rating.create({ data: { order_id: orderId, user_id: userIds[o.phone], driver_id: driverId, stars: o.rating } });
      }
      // The technician's quote for more work: its own order, waiting to be paid.
      if (o.extra) {
        // eslint-disable-next-line no-await-in-loop
        const extra = await tx.order.create({
          data: {
            user_phone: o.phone, user_id: userIds[o.phone], status: 'PENDING_PAYMENT', total_amount: o.extra.amount,
            items: [], lat: o.lat, lng: o.lng, landmark_text: o.landmark, kind: 'SERVICE', subtotal: '0.00',
            fee: o.extra.amount, trade: o.trade, details: o.extra.details, parent_order_id: orderId, requested_driver_id: driverId,
          },
          select: { id: true },
        });
        // eslint-disable-next-line no-await-in-loop
        await tx.orderEvent.create({ data: { order_id: extra.id, to_status: 'PENDING_PAYMENT', actor: 'system', note: 'extra work quoted' } });
        // eslint-disable-next-line no-await-in-loop
        await tx.deliveryHandoff.create({ data: { order_id: extra.id, code: '6390' } });
      }

      if (o.refPhoto) photoJobs.push({ orderId, kind: 'order_ref', label: 'Reference', bg: '#e6c65c' });
      if (o.proofPhoto) photoJobs.push({ orderId, kind: 'delivery_proof', label: '📦 Delivered', bg: '#d4af37' });
    }

    // The pending order's customer has said "I've paid", so the operator's screen shows a
    // payment waiting to be checked against the merchant phone.
    await tx.order.updateMany({
      where: { status: 'PENDING_PAYMENT', kind: 'DELIVERY' },
      data: { payment_claimed_at: new Date(), payment_claim_ref: 'SEED-EVC-0001' },
    });

    // A wallet with money in it (the mockup's $25.60), and a USSD top-up waiting for the desk.
    const walletUser = userIds['+252612345678'];
    await tx.transaction.create({
      data: { telecom_receipt_id: 'SEED-TOPUP-1', sender_msisdn: '', amount: '25.60', matched: true, provider: 'manual', sender_name: 'wallet-topup:seed' },
    });
    await tx.walletAccount.create({ data: { user_id: walletUser, balance_cents: 2560n } });
    await tx.walletEntry.create({
      data: { user_id: walletUser, amount_cents: 2560n, balance_after_cents: 2560n, kind: 'topup', reference: 'SEED-TOPUP-1', actor: 'operator:seed' },
    });
    await tx.paymentAttempt.create({
      data: {
        id: '00000000-0000-4000-8000-00000000a001', user_id: userIds['+252651234567'], purpose: 'topup', provider: 'manual',
        wallet: 'evcplus', payer: '', amount: '10.00', status: 'claimed', claim_ref: 'SEED-EVC-0002',
      },
    });
    // A customer's suggestion for the catalog, waiting for review.
    await tx.catalogSubmission.create({
      data: { user_id: userIds['+252771234567'], name: 'Camel meat', note: 'Sold at Bakaara, about $8 a kilo', service: 'grocery' },
    });
  }, { timeout: 30000 });

  // Photos: upload bytes to MinIO, then index them. Deterministic keys → idempotent overwrite.
  for (const job of photoJobs) {
    const key = `orders/${job.orderId}/${job.kind}.svg`;
    try {
      // eslint-disable-next-line no-await-in-loop
      await putObject(key, svgPhoto(job.label, job.bg), 'image/svg+xml');
      // eslint-disable-next-line no-await-in-loop
      await prisma.orderPhoto.upsert({
        where: { object_key: key },
        update: { created_at: new Date() },
        create: {
          order_id: job.orderId,
          kind: job.kind,
          object_key: key,
          content_type: 'image/svg+xml',
          uploaded_by: 'system',
        },
      });
    } catch (err) {
      console.warn(`⚠ photo seed skipped for order ${job.orderId} (${job.kind}): ${err.message}`);
    }
  }

  const counts = await prisma.order.groupBy({ by: ['status'], _count: { _all: true } });
  console.log('Seed complete. Orders by status:');
  for (const c of counts.sort((a, b) => a.status.localeCompare(b.status))) {
    console.log(`  ${c.status.padEnd(16)} ${c._count._all}`);
  }
  console.log(`Drivers: ${DRIVERS.map((d) => `${d.name}/${d.pin}`).join(', ')}`);
  console.log(`Operators: ${OPERATORS.map((o) => `${o.username}/${o.password}${o.isAdmin ? ' (admin)' : ''}`).join(', ')}`);
  await prisma.$disconnect();
}

seed().catch((err) => { console.error('Seed failed:', err); process.exit(1); });
