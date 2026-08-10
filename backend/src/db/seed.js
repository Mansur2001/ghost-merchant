// Idempotent, re-runnable dev seed. Running it any number of times converges the database
// to the SAME known state (TRUNCATE ... RESTART IDENTITY, then insert) — so you can reset to
// a full, workflow-complete dataset whenever the data drifts. Covers EVERY order state plus
// an unmatched receipt and seeded photos, so all three PWAs have something real to work with.
//
//   docker compose exec backend npm run seed
//
// Refuses to run against NODE_ENV=production unless SEED_FORCE=1 (it wipes domain tables).
import { prisma } from './prisma.js';
import { hashSecret } from '../middleware/auth.js';
import { putObject } from '../storage/objectStore.js';

if (process.env.NODE_ENV === 'production' && process.env.SEED_FORCE !== '1') {
  console.error('Refusing to seed in production (this TRUNCATEs domain tables). Set SEED_FORCE=1 to override.');
  process.exit(1);
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
const OPERATORS = [
  { username: 'admin', displayName: 'Bootstrap operator', password: 'change-me-please-1' },
  { username: 'hodan', displayName: 'Hodan (dispatch)', password: 'seeded-operator-pw-1' },
];

const DRIVERS = [
  { name: 'Amina', msisdn: '+252619876543', pin: '1234' },
  { name: 'Bashir', msisdn: '+252651112223', pin: '5678' },
];

const USERS = ['+252612345678', '+252651234567', '+252771234567'];

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
];

async function seed() {
  const photoJobs = []; // { orderId, kind, ... } to upload after the DB commit

  await prisma.$transaction(async (tx) => {
    // Reset to a clean slate with deterministic sequences. Raw because Prisma has no
    // TRUNCATE ... RESTART IDENTITY CASCADE — and deleteMany() in dependency order would be
    // both slower and easy to get subtly wrong as the schema grows.
    await tx.$executeRawUnsafe(`
      TRUNCATE outbox, otp_codes, order_photos, order_events, messages, transactions,
               refunds, orders, drivers, users, operators
      RESTART IDENTITY CASCADE
    `);

    await tx.user.createMany({ data: USERS.map((phone_number) => ({ phone_number })) });

    await tx.operator.createMany({
      data: OPERATORS.map((o) => ({
        username: o.username,
        display_name: o.displayName,
        password_hash: hashSecret(o.password),
        created_by: 'system:seed',
      })),
    });

    const driverIds = [];
    for (const d of DRIVERS) {
      // eslint-disable-next-line no-await-in-loop
      const created = await tx.driver.create({
        data: { name: d.name, msisdn: d.msisdn, pin_hash: hashSecret(d.pin) },
        select: { id: true },
      });
      driverIds.push(created.id);
    }

    let receiptSeq = 1;
    for (const o of ORDERS) {
      const driverId = o.driverIdx ? driverIds[o.driverIdx - 1] : null;
      // eslint-disable-next-line no-await-in-loop
      const order = await tx.order.create({
        data: {
          user_phone: o.phone,
          status: o.status,
          total_amount: o.amount,
          items: o.items,
          lat: o.lat,
          lng: o.lng,
          landmark_text: o.landmark,
          driver_id: driverId,
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
      const messages = [{ order_id: orderId, sender: 'user', body: o.items[0].text }];
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
            raw_sms: `You have received $${o.amount} from ${o.phone}. Ref SEED-RCPT.`,
            matched: true,
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

      if (o.refPhoto) photoJobs.push({ orderId, kind: 'order_ref', label: 'Reference', bg: '#e6c65c' });
      if (o.proofPhoto) photoJobs.push({ orderId, kind: 'delivery_proof', label: '📦 Delivered', bg: '#d4af37' });
    }

    // One unmatched receipt so the operator's reconcile queue has a real item to resolve.
    await tx.transaction.create({
      data: {
        order_id: null,
        telecom_receipt_id: 'SEED-UNMATCHED-1',
        sender_msisdn: '+252612345678',
        amount: '99.00',
        raw_sms: 'You have received $99.00 from +252612345678. Ref SEED-UNMATCHED.',
        matched: false,
      },
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
  console.log(`Operators: ${OPERATORS.map((o) => `${o.username}/${o.password}`).join(', ')}`);
  await prisma.$disconnect();
}

seed().catch((err) => { console.error('Seed failed:', err); process.exit(1); });
