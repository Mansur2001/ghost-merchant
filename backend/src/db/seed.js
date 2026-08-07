// Idempotent, re-runnable dev seed. Running it any number of times converges the database
// to the SAME known state (TRUNCATE ... RESTART IDENTITY, then insert) — so you can reset to
// a full, workflow-complete dataset whenever the data drifts. Covers EVERY order state plus
// an unmatched receipt and seeded photos, so all three PWAs have something real to work with.
//
//   docker compose exec backend npm run seed
//
// Refuses to run against NODE_ENV=production unless SEED_FORCE=1 (it wipes domain tables).
import { pool } from './pool.js';
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
  const client = await pool.connect();
  const photoJobs = []; // { orderId, kind, key } to upload after the DB commit
  try {
    await client.query('BEGIN');

    // Reset to a clean slate with deterministic ids/sequences.
    await client.query(
      `TRUNCATE otp_codes, order_photos, order_events, messages, transactions, orders,
                drivers, users
       RESTART IDENTITY CASCADE`
    );

    for (const phone of USERS) {
      await client.query('INSERT INTO users(phone_number) VALUES ($1)', [phone]);
    }

    const driverIds = [];
    for (const d of DRIVERS) {
      const { rows } = await client.query(
        'INSERT INTO drivers(name, msisdn, pin_hash) VALUES ($1, $2, $3) RETURNING id',
        [d.name, d.msisdn, hashSecret(d.pin)]
      );
      driverIds.push(rows[0].id);
    }

    let receiptSeq = 1;
    for (const o of ORDERS) {
      const driverId = o.driverIdx ? driverIds[o.driverIdx - 1] : null;
      const { rows } = await client.query(
        `INSERT INTO orders(user_phone, status, total_amount, items, lat, lng, landmark_text, driver_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [o.phone, o.status, o.amount, JSON.stringify(o.items), o.lat, o.lng, o.landmark, driverId]
      );
      const orderId = rows[0].id;

      // Synthesize the audit trail for the path this order has walked.
      const path = PATHS[o.status];
      let from = null;
      for (const to of path) {
        const actor = ['DISPATCHED', 'IN_TRANSIT', 'DELIVERED'].includes(to) && driverId
          ? `driver:${driverId}` : 'system';
        await client.query(
          `INSERT INTO order_events(order_id, from_status, to_status, actor, note)
           VALUES ($1, $2, $3, $4, $5)`,
          [orderId, from, to, actor, 'seed']
        );
        from = to;
      }

      // A couple of chat messages so the thread isn't empty.
      await client.query(
        `INSERT INTO messages(order_id, sender, body) VALUES ($1, 'user', $2)`,
        [orderId, o.items[0].text]
      );
      if (o.status !== 'PENDING_PAYMENT') {
        await client.query(
          `INSERT INTO messages(order_id, sender, body) VALUES ($1, 'system', $2)`,
          [orderId, 'Payment confirmed. We are coordinating your delivery.']
        );
      }

      // Matched receipt for every order that has been paid.
      if (o.status !== 'PENDING_PAYMENT' && o.status !== 'FAILED_REFUND') {
        await client.query(
          `INSERT INTO transactions(order_id, telecom_receipt_id, sender_msisdn, amount, raw_sms, matched)
           VALUES ($1, $2, $3, $4, $5, true)`,
          [orderId, `SEED-RCPT-${receiptSeq++}`, o.phone, o.amount,
           `You have received $${o.amount} from ${o.phone}. Ref SEED-RCPT.`]
        );
      }

      if (o.refPhoto) photoJobs.push({ orderId, kind: 'order_ref', label: 'Reference', bg: '#e6c65c' });
      if (o.proofPhoto) photoJobs.push({ orderId, kind: 'delivery_proof', label: '📦 Delivered', bg: '#d4af37' });
    }

    // One unmatched receipt so the operator's reconcile queue has a real item to resolve.
    await client.query(
      `INSERT INTO transactions(order_id, telecom_receipt_id, sender_msisdn, amount, raw_sms, matched)
       VALUES (NULL, 'SEED-UNMATCHED-1', '+252612345678', '99.00',
               'You have received $99.00 from +252612345678. Ref SEED-UNMATCHED.', false)`
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Photos: upload bytes to MinIO, then index them. Deterministic keys → idempotent overwrite.
  for (const job of photoJobs) {
    const ext = 'svg';
    const key = `orders/${job.orderId}/${job.kind}.${ext}`;
    try {
      await putObject(key, svgPhoto(job.label, job.bg), 'image/svg+xml');
      await pool.query(
        `INSERT INTO order_photos(order_id, kind, object_key, content_type, uploaded_by)
         VALUES ($1, $2, $3, 'image/svg+xml', 'system')
         ON CONFLICT (object_key) DO UPDATE SET created_at = now()`,
        [job.orderId, job.kind, key]
      );
    } catch (err) {
      console.warn(`⚠ photo seed skipped for order ${job.orderId} (${job.kind}): ${err.message}`);
    }
  }

  const { rows } = await pool.query('SELECT status, count(*) FROM orders GROUP BY status ORDER BY status');
  console.log('Seed complete. Orders by status:');
  for (const r of rows) console.log(`  ${r.status.padEnd(16)} ${r.count}`);
  console.log(`Drivers: ${DRIVERS.map((d) => `${d.name}/${d.pin}`).join(', ')}`);
  await pool.end();
}

seed().catch((err) => { console.error('Seed failed:', err); process.exit(1); });
