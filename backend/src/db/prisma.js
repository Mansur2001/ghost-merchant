// Prisma client + the transaction helpers the CAP design depends on.
//
// Prisma owns the schema and the ordinary queries. It does NOT own the parts of this system
// where Postgres semantics are the feature: row locks, SKIP LOCKED, advisory locks, and
// per-transaction `synchronous_commit`. Those stay as raw SQL executed through Prisma's
// interactive transactions, which run on a single pinned connection — the property all of
// them require.
//
// If you find yourself reaching for `$queryRaw` outside those cases, use the model API
// instead; the point of the raw escape hatch is the things Prisma genuinely cannot express.
import { PrismaClient } from '@prisma/client';
import { config } from '../config.js';

// BIGSERIAL columns come back from Prisma as BigInt, and `JSON.stringify` THROWS on BigInt —
// so without this every route returning a driver, message or photo id would 500.
//
// `pg` used to return int8 as a string, and the PWAs already read these as strings, so
// serializing BigInt the same way keeps the API contract byte-identical across this
// migration. (Prisma's Decimal already serializes to a string, matching NUMERIC under pg.)
//
// Patching a builtin is worth flagging: it is global and permanent for the process. The
// alternative — mapping every id at every call site — is far easier to get wrong in one
// forgotten route, and that route would be a 500 in production.
if (typeof BigInt.prototype.toJSON !== 'function') {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function toJSON() {
      return this.toString();
    },
    writable: true,
    configurable: true,
  });
}

export const prisma = new PrismaClient({
  datasources: { db: { url: config.db.url } },
  // Query logs would print phone numbers and message bodies straight past domain/redact.js.
  log: config.env === 'production' ? ['warn', 'error'] : ['warn', 'error'],
});

// Raised when a critical write could not be confirmed durable. Distinct from an ordinary
// failure because the honest answer to the customer is "we don't know", not "it failed".
export class WriteUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.status = 503;
    this.code = 'WRITE_UNAVAILABLE';
  }
}

// Timeouts for interactive transactions. `maxWait` is how long to wait for a free connection;
// `timeout` is how long the transaction body may run before Prisma rolls it back.
const TX_OPTIONS = {
  maxWait: 5000,
  timeout: 15000,
};

// ── AP path: tracking, chat, photos ──
//
// `synchronous_commit = local` commits to THIS server's WAL and returns without waiting for a
// replica. If the primary is lost seconds later a chat message can be lost — acceptable for a
// message the customer can retype. What it buys is that chat stays responsive when the
// standby is slow or unreachable, which over Somali mobile networks is often. This is the A
// in CAP, chosen per-operation.
export async function withTransaction(fn) {
  return prisma.$transaction(async (tx) => {
    // SET LOCAL is scoped to this transaction, so it cannot leak onto the next borrower of
    // the pooled connection — a plain SET would silently change durability for unrelated
    // writes, the kind of bug nobody finds until an outage.
    await tx.$executeRawUnsafe(`SET LOCAL synchronous_commit = ${config.db.apCommit}`);
    return fn(tx);
  }, TX_OPTIONS);
}

// ── CP path: money and state transitions ──
//
// Payments, order transitions and driver assignment must be linearizable. With a synchronous
// standby configured, `remote_apply` means the commit is not acknowledged until the standby
// has applied it, so an acknowledged payment survives losing the primary outright.
//
// On a partition a synchronous commit would otherwise HANG forever waiting for a standby that
// isn't there. The statement timeout turns that into a fast, explicit failure: we REFUSE the
// write rather than hanging the request or acknowledging something we cannot guarantee. That
// is the CAP choice made real — on partition, choose consistency and become unavailable,
// loudly.
//
// Surfaces as 503 WRITE_UNAVAILABLE. For a payment the honest message is "we couldn't confirm
// this right now" — never "your payment failed", because it may well have gone through on the
// customer's phone.
export async function withCriticalTransaction(fn) {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL synchronous_commit = ${config.db.cpCommit}`);
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${config.db.criticalTimeoutMs}`);
      return fn(tx);
    }, TX_OPTIONS);
  } catch (err) {
    // 57014 = query_canceled (statement_timeout). Under a synchronous-replication partition
    // this is what a stalled commit looks like.
    if (err?.code === '57014' || err?.meta?.code === '57014') {
      throw new WriteUnavailableError(
        'could not confirm the write durably within the timeout — refusing rather than ' +
          'acknowledging something we cannot guarantee'
      );
    }
    throw err;
  }
}

// Run `fn` inside the caller's transaction if there is one, otherwise open a new one.
// Lets a command compose into a bigger transaction (receipt + state transition + outbox rows
// must commit together) without duplicating it into two near-identical functions.
export function inTransaction(client, fn) {
  return client ? fn(client) : withTransaction(fn);
}

export async function disconnect() {
  await prisma.$disconnect();
}
