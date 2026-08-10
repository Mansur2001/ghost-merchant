// Transactional outbox: the bridge between "the database says it happened" and "everyone
// connected knows it happened".
//
// CONTRACT — read before adding an event:
//   1. `enqueue` REQUIRES the transaction's client. Passing the pool would defeat the whole
//      mechanism: the row would commit independently of the state change it describes.
//   2. Delivery is AT-LEAST-ONCE. The relay can publish and then crash before marking the
//      row, and will republish on restart. Every consumer must be idempotent. Today's
//      consumers are socket broadcasts — re-sending "order 4 is now IN_TRANSIT" is harmless
//      because it's a state snapshot, not a delta. Keep new events shaped that way.
//   3. Ordering is by `id`, i.e. write order, and is preserved across instances by electing
//      a SINGLE relay with a Postgres advisory lock (see "Relay leadership" below). Without
//      that, two backends each claim a different subset via SKIP LOCKED and publish
//      concurrently — a customer could see "delivered" before "in transit".
import { prisma, withTransaction } from '../db/prisma.js';
import { publish } from './bus.js';

const POLL_INTERVAL_MS = 1000; // floor on delivery latency if nothing calls wake()
const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 5;
const RETENTION_DAYS = 7; // keep delivered rows around; they're the "why did this happen" log

// Write an event inside the caller's transaction. `client` is mandatory and checked, because
// the failure mode of getting this wrong is silent and only shows up during an outage.
export async function enqueue(client, eventName, payload) {
  // The check is on the Prisma transaction client's model API. Passing the base client would
  // commit the row independently of the state change it describes — silently reintroducing
  // the exact bug the outbox exists to fix.
  if (!client || typeof client.outbox?.create !== 'function') {
    throw new Error('enqueue requires the transaction client — pass the tx client, not the base client');
  }
  const row = await client.outbox.create({
    data: { event_name: eventName, payload: payload ?? {} },
    select: { id: true },
  });
  return row.id;
}

// Publish one batch of committed-but-undelivered events.
//
// FOR UPDATE SKIP LOCKED means a second relay (or a second instance) never double-processes
// the same row. The whole batch runs in one transaction: if the process dies mid-batch, the
// marks roll back and the events are redelivered — at-least-once, by design.
export async function relayOnce({ batchSize = BATCH_SIZE } = {}) {
  return withTransaction(async (tx) => {
    // Only one instance relays at a time; the lock is released when this transaction ends.
    if (!(await claimRelayLock(tx))) return { fetched: 0, delivered: 0, skipped: true };

    // RAW, and it must stay raw: FOR UPDATE SKIP LOCKED has no Prisma equivalent. It is what
    // stops a second relay (or a second instance) from double-processing the same row.
    const rows = await tx.$queryRaw`
      SELECT id, event_name, payload, attempts
        FROM outbox
       WHERE published_at IS NULL AND NOT failed
       ORDER BY id
       LIMIT ${batchSize}
       FOR UPDATE SKIP LOCKED
    `;

    let delivered = 0;
    for (const row of rows) {
      try {
        publish(row.event_name, row.payload);
        // eslint-disable-next-line no-await-in-loop
        await tx.outbox.update({ where: { id: row.id }, data: { published_at: new Date() } });
        delivered += 1;
      } catch (err) {
        const attempts = Number(row.attempts) + 1;
        // A poison event must not wedge the queue forever. After MAX_ATTEMPTS we park it and
        // move on: Postgres remains the source of truth, and clients resync on reload, so a
        // stuck relay is worse than one dropped notification.
        const giveUp = attempts >= MAX_ATTEMPTS;
        // eslint-disable-next-line no-await-in-loop
        await tx.outbox.update({
          where: { id: row.id },
          data: { attempts, last_error: String(err?.message).slice(0, 500), failed: giveUp },
        });
        console.error(
          JSON.stringify({
            t: new Date().toISOString(),
            level: 'error',
            msg: giveUp ? 'outbox event PARKED after repeated failures' : 'outbox publish failed',
            outboxId: String(row.id),
            event: row.event_name,
            attempts,
            error: err?.message,
          })
        );
        if (giveUp) continue;
        // Stop the batch here: publishing later rows now would reorder this order's events.
        break;
      }
    }
    return { fetched: rows.length, delivered };
  });
}

// Delete long-delivered rows. Kept for a week first: when someone asks "why did this order
// flip to DISPATCHED at 3am", this table is the answer.
export async function sweepOutbox() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.outbox.deleteMany({
    where: { published_at: { not: null, lt: cutoff } },
  });
  return count;
}

// How far behind the relay is. Surfaced to the operator dashboard: a growing backlog means
// clients are seeing stale state, which looks exactly like "the app is broken".
export async function outboxHealth() {
  const [pending, parked, oldest] = await Promise.all([
    prisma.outbox.count({ where: { published_at: null, failed: false } }),
    prisma.outbox.count({ where: { failed: true } }),
    prisma.outbox.findFirst({
      where: { published_at: null, failed: false },
      orderBy: { created_at: 'asc' },
      select: { created_at: true },
    }),
  ]);
  return {
    pending,
    parked,
    oldest_pending_seconds: oldest
      ? Math.max(0, Math.round((Date.now() - oldest.created_at.getTime()) / 1000))
      : 0,
  };
}

// ── Relay leadership ──
//
// Ordering is by `id`, and that only holds with ONE relay running at a time. Two instances
// both claiming rows with SKIP LOCKED each get a different subset and publish concurrently,
// so a customer could see "delivered" before "in transit".
//
// A TRANSACTION-SCOPED advisory lock gives us that: whoever holds it relays this batch, and
// it is released automatically at commit — or at rollback, or if the process dies mid-batch.
// There is no lease to expire, no held connection, and no split brain, because the lock lives
// in the same database as the truth it protects.
//
// (This was a session-scoped lock while the data layer was raw `pg`, which needed a
// connection pinned for the process lifetime. Prisma's pool doesn't expose one — and the
// transaction-scoped form turns out to be the better design anyway: leadership is per batch,
// so failover is instant instead of waiting for a dead holder's connection to time out.)
const RELAY_LOCK_KEY = 0x60057; // arbitrary but fixed: "ghost" in leetspeak

let lastLeaderState = false;
export function isRelayLeader() {
  return lastLeaderState;
}

// Try to take the relay lock inside `tx`. Returns false if another instance holds it.
async function claimRelayLock(tx) {
  const rows = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(${RELAY_LOCK_KEY}) AS ok`;
  const ok = rows[0]?.ok === true;
  if (ok !== lastLeaderState) {
    lastLeaderState = ok;
    if (ok) console.log('outbox relay: this instance is relaying');
  }
  return ok;
}

// ── Relay loop ──
let timer = null;
let running = false;
let pendingWake = false;

async function drain() {
  // Never run two drains concurrently: they'd contend on the same rows and the loser would
  // do nothing useful. A wake that arrives mid-drain is remembered and runs after.
  if (running) {
    pendingWake = true;
    return;
  }
  running = true;
  try {
    // Keep going while full batches come back, so a backlog clears promptly instead of one
    // batch per tick.
    let more = true;
    while (more) {
      const { fetched } = await relayOnce();
      more = fetched === BATCH_SIZE;
    }
  } catch (err) {
    console.error('outbox relay error:', err.message);
  } finally {
    running = false;
    if (pendingWake) {
      pendingWake = false;
      setImmediate(drain);
    }
  }
}

// Call right AFTER a transaction commits, for immediate delivery instead of waiting up to
// POLL_INTERVAL_MS. Forgetting it costs latency, never correctness — the poll catches it.
export function wakeOutbox() {
  setImmediate(drain);
}

export function startOutboxRelay() {
  if (timer) return;
  timer = setInterval(drain, POLL_INTERVAL_MS);
  timer.unref();
  drain(); // deliver anything left over from a previous run's crash
  console.log('Outbox relay started');
}

export function stopOutboxRelay() {
  if (timer) clearInterval(timer);
  timer = null;
  lastLeaderState = false;
  // Nothing to hand over: the advisory lock is transaction-scoped, so it was already released
  // when the last batch committed.
}
