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
import { pool, query, withTransaction } from '../db/pool.js';
import { publish } from './bus.js';

const POLL_INTERVAL_MS = 1000; // floor on delivery latency if nothing calls wake()
const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 5;
const RETENTION_DAYS = 7; // keep delivered rows around; they're the "why did this happen" log

// Write an event inside the caller's transaction. `client` is mandatory and checked, because
// the failure mode of getting this wrong is silent and only shows up during an outage.
export async function enqueue(client, eventName, payload) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('enqueue requires the transaction client — pass the tx client, not the pool');
  }
  const { rows } = await client.query(
    'INSERT INTO outbox(event_name, payload) VALUES ($1, $2) RETURNING id',
    [eventName, JSON.stringify(payload ?? {})]
  );
  return rows[0].id;
}

// Publish one batch of committed-but-undelivered events.
//
// FOR UPDATE SKIP LOCKED means a second relay (or a second instance) never double-processes
// the same row. The whole batch runs in one transaction: if the process dies mid-batch, the
// marks roll back and the events are redelivered — at-least-once, by design.
export async function relayOnce({ batchSize = BATCH_SIZE } = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, event_name, payload, attempts
         FROM outbox
        WHERE published_at IS NULL AND NOT failed
        ORDER BY id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize]
    );

    let delivered = 0;
    for (const row of rows) {
      try {
        publish(row.event_name, row.payload);
        await client.query('UPDATE outbox SET published_at = now() WHERE id = $1', [row.id]);
        delivered += 1;
      } catch (err) {
        const attempts = row.attempts + 1;
        // A poison event must not wedge the queue forever. After MAX_ATTEMPTS we park it and
        // move on: Postgres remains the source of truth, and clients resync on reload, so a
        // stuck relay is worse than one dropped notification.
        const giveUp = attempts >= MAX_ATTEMPTS;
        await client.query(
          'UPDATE outbox SET attempts = $1, last_error = $2, failed = $3 WHERE id = $4',
          [attempts, String(err?.message).slice(0, 500), giveUp, row.id]
        );
        console.error(
          JSON.stringify({
            t: new Date().toISOString(),
            level: 'error',
            msg: giveUp ? 'outbox event PARKED after repeated failures' : 'outbox publish failed',
            outboxId: row.id,
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
  const { rowCount } = await query(
    `DELETE FROM outbox
      WHERE published_at IS NOT NULL AND published_at < now() - ($1 || ' days')::interval`,
    [String(RETENTION_DAYS)]
  );
  return rowCount;
}

// How far behind the relay is. Surfaced to the operator dashboard: a growing backlog means
// clients are seeing stale state, which looks exactly like "the app is broken".
export async function outboxHealth() {
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE published_at IS NULL AND NOT failed)::int AS pending,
       count(*) FILTER (WHERE failed)::int                             AS parked,
       COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at)
         FILTER (WHERE published_at IS NULL AND NOT failed))), 0)::int AS oldest_pending_seconds
     FROM outbox`
  );
  return rows[0];
}

// ── Relay leadership ──
//
// Ordering is by `id`, and that only holds with ONE relay. Two instances both claiming rows
// with SKIP LOCKED each get a different subset and publish them concurrently, so a customer
// could see "delivered" before "in transit".
//
// So exactly one instance relays at a time, elected by a Postgres session-scoped advisory
// lock. No new infrastructure, and no split brain: the lock lives in the same database as the
// truth it protects, and it is released AUTOMATICALLY if the holder dies or its connection
// drops — which is precisely the failure a lease-with-timeout scheme has to hand-roll.
//
// The non-leaders idle. Failover costs at most one poll interval.
const RELAY_LOCK_KEY = 0x60057; // arbitrary but fixed: "ghost" in leetspeak
let lockClient = null;
let isLeader = false;

async function tryBecomeLeader() {
  if (isLeader) return true;
  try {
    // A dedicated connection, held for as long as we lead: advisory locks are scoped to the
    // session, so returning this client to the pool would release the lock.
    if (!lockClient) lockClient = await pool.connect();
    const { rows } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [
      RELAY_LOCK_KEY,
    ]);
    isLeader = rows[0].ok === true;
    if (isLeader) console.log('outbox relay: this instance is the leader');
    return isLeader;
  } catch (err) {
    // Connection died — drop it so the next tick reconnects and re-contests the lock.
    console.error('outbox relay: leadership check failed:', err.message);
    try { lockClient?.release(); } catch { /* already gone */ }
    lockClient = null;
    isLeader = false;
    return false;
  }
}

async function releaseLeadership() {
  if (!lockClient) return;
  try {
    if (isLeader) await lockClient.query('SELECT pg_advisory_unlock($1)', [RELAY_LOCK_KEY]);
  } catch { /* the session is going away anyway */ }
  try { lockClient.release(); } catch { /* already released */ }
  lockClient = null;
  isLeader = false;
}

export function isRelayLeader() {
  return isLeader;
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
  if (!(await tryBecomeLeader())) return; // another instance is relaying
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

export async function stopOutboxRelay() {
  if (timer) clearInterval(timer);
  timer = null;
  // Hand leadership over immediately rather than making the next instance wait for our
  // connection to time out — a rolling deploy should not pause event delivery.
  await releaseLeadership();
}
