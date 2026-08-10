// Guard for the part of the schema Prisma cannot see.
//
// Partial indexes and CHECK constraints are declared in raw migration SQL, not schema.prisma.
// If a database is ever rebuilt from the schema alone — or a migration is edited carelessly —
// they vanish SILENTLY, and the first symptom is duplicated chat messages or a negative order
// total in production. This asserts they exist.
//
//   npm run db:verify
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const REQUIRED_INDEXES = {
  idx_messages_client_id: 'offline-queue idempotency: a replayed message must land only once',
  idx_outbox_pending: "the relay's hot query over undelivered events",
  idx_outbox_published_at: 'retention sweep by age',
  idx_operators_active: 'login lookup among active accounts',
  idx_refunds_one_open: 'one open refund per order',
  idx_refunds_owed: 'the reconciliation queue',
};

const REQUIRED_CHECKS = {
  orders_total_amount_check: 'an order total can never be negative',
  order_photos_kind_check: 'photo kind is one of the two known values',
  refunds_amount_check: 'a refund can never be negative',
  refunds_status_check: 'refund status is one of owed/settled/waived',
};

const indexes = await prisma.$queryRaw`
  SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
`;
const checks = await prisma.$queryRaw`
  SELECT conname FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace
`;

const haveIndexes = new Set(indexes.map((r) => r.indexname));
const haveChecks = new Set(checks.map((r) => r.conname));

let missing = 0;
for (const [name, why] of Object.entries(REQUIRED_INDEXES)) {
  if (haveIndexes.has(name)) console.log(`  ✓ index  ${name}`);
  else { console.error(`  ✗ MISSING index ${name} — ${why}`); missing += 1; }
}
for (const [name, why] of Object.entries(REQUIRED_CHECKS)) {
  if (haveChecks.has(name)) console.log(`  ✓ check  ${name}`);
  else { console.error(`  ✗ MISSING check ${name} — ${why}`); missing += 1; }
}

// The unique-ness of the message key is the one that silently corrupts data, so assert it
// really is UNIQUE and not just present.
const [{ indexdef } = {}] = await prisma.$queryRaw`
  SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_messages_client_id'
`;
if (indexdef && !/CREATE UNIQUE INDEX/i.test(indexdef)) {
  console.error('  ✗ idx_messages_client_id exists but is NOT UNIQUE — replays would duplicate');
  missing += 1;
}

await prisma.$disconnect();
if (missing > 0) {
  console.error(`\n${missing} schema guard(s) missing. Do not deploy this.`);
  process.exit(1);
}
console.log('\nAll schema guards present.');
