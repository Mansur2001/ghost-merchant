// Empty the database to a REAL first-run state.
//
// `npm run seed` fills the system with demo data, which is the right thing for a screenshot
// or a walkthrough but hides the experience that actually matters: what a customer, driver or
// operator sees on day one, when there are no orders, no drivers, and nothing has happened.
// Empty states are where an app looks broken, and they are the ones nobody ever reviews.
//
// This leaves exactly what a fresh deployment has:
//   * no orders, no customers, no messages, no payments, no refunds
//   * no drivers — the operator creates them
//   * ONE operator, the bootstrap account, created from OPERATOR_PASSWORD on next boot
//
//   docker compose exec backend npm run db:reset-clean
//
// Refuses to run against a production database without an explicit override, because on a
// live system this is a catastrophe rather than a convenience.
import { prisma } from './prisma.js';

if (process.env.NODE_ENV === 'production' && process.env.RESET_FORCE !== '1') {
  console.error(
    'Refusing to wipe a production database. This deletes every order, payment and refund.\n' +
      'If you genuinely mean it: RESET_FORCE=1'
  );
  process.exit(1);
}

const KEEP_OPERATORS = process.env.KEEP_OPERATORS !== '0';

await prisma.$executeRawUnsafe(`
  TRUNCATE outbox, otp_codes, order_photos, order_events, messages, transactions,
           refunds, access_requests, orders, drivers, users
  RESTART IDENTITY CASCADE
`);

if (!KEEP_OPERATORS) {
  // Dropping every operator means the next boot recreates the bootstrap account from
  // OPERATOR_PASSWORD — the true zero state.
  await prisma.$executeRawUnsafe('TRUNCATE operators RESTART IDENTITY CASCADE');
}

const counts = {
  orders: await prisma.order.count(),
  drivers: await prisma.driver.count(),
  operators: await prisma.operator.count(),
  customers: await prisma.user.count(),
};

console.log('Database is now at a clean first-run state:');
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(11)} ${v}`);
if (counts.operators === 0) {
  console.log('\nRestart the backend — it will create the bootstrap operator from OPERATOR_PASSWORD.');
}
await prisma.$disconnect();
