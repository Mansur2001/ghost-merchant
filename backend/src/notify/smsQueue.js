// Outbound SMS queue for the Oracle phone.
//
// THE CONNECTIVITY PROBLEM THIS SOLVES: a phone cannot accept inbound connections. On mobile
// data it is behind carrier-grade NAT; on WiFi it is behind a router. A backend on a VPS can
// never open a socket to it without a VPN or a tunnel — another dependency, another thing to
// break, another vendor.
//
// So the direction is inverted. The backend queues; the Oracle POLLS. The phone already polls
// its inbox for incoming receipts, so it collects outgoing messages on the same tick. This
// works from any network, behind any NAT, with no configuration.
//
// This is what makes SMS login viable in Somalia WITHOUT a telecom integration: the code goes
// out over the merchant's own SIM at normal subscriber tariff.
//
// PLAINTEXT: a queued row contains a live login code. The hashed copy in otp_codes is the
// authoritative one; this exists only long enough to be delivered, and is deleted the moment
// the phone confirms. Anything the phone never collected is swept.
import { prisma } from '../db/prisma.js';

// A code is useless after its 5-minute TTL, so an undelivered message is dead weight — and
// dead weight here means a plaintext credential sitting in a table.
const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
// If the phone claims a message and then dies, the claim must expire or it is never resent.
const CLAIM_TIMEOUT_MS = 60 * 1000;

export async function queueSms({ to, body }) {
  const row = await prisma.smsOutbox.create({
    data: { to, body },
    select: { id: true },
  });
  return row.id;
}

// Messages for the Oracle to send. Claiming marks them so two polls in flight don't send the
// same code twice — a customer receiving the same code twice is harmless, but receiving two
// DIFFERENT codes because of a race is not, and the claim keeps the ordering honest.
export async function claimPendingSms(limit = 5) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - CLAIM_TIMEOUT_MS);

  // RAW, and it must stay raw: FOR UPDATE SKIP LOCKED. Prisma has no row-lock API, and
  // without it two concurrent polls hand the same message to the phone twice.
  const rows = await prisma.$queryRaw`
    SELECT id, "to", body FROM sms_outbox
     WHERE status = 'pending'
       AND attempts < ${MAX_ATTEMPTS}
       AND (claimed_at IS NULL OR claimed_at < ${staleBefore})
     ORDER BY id
     LIMIT ${limit}
     FOR UPDATE SKIP LOCKED
  `;
  if (rows.length === 0) return [];

  await prisma.smsOutbox.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { claimed_at: now, attempts: { increment: 1 } },
  });

  return rows.map((r) => ({ id: String(r.id), to: r.to, body: r.body }));
}

// The phone reports what happened. A delivered message is DELETED rather than marked sent:
// keeping it would leave a plaintext login code in the database for no reason.
export async function confirmSms({ id, ok, error }) {
  const key = BigInt(id);
  if (ok) {
    await prisma.smsOutbox.deleteMany({ where: { id: key } });
    return { deleted: true };
  }
  await prisma.smsOutbox.updateMany({
    where: { id: key },
    data: {
      status: 'pending', // let it be retried until attempts run out
      claimed_at: null,
      last_error: String(error || 'unknown').slice(0, 300),
    },
  });
  return { deleted: false };
}

// Housekeeping: drop anything too old to be useful, and anything that exhausted its retries.
// Both cases are a plaintext code we no longer have a reason to hold.
export async function sweepSmsQueue() {
  const { count } = await prisma.smsOutbox.deleteMany({
    where: {
      OR: [
        { created_at: { lt: new Date(Date.now() - MAX_AGE_MS) } },
        { attempts: { gte: MAX_ATTEMPTS } },
      ],
    },
  });
  return count;
}

// Surfaced to the operator: a backlog means customers are not receiving login codes, which
// looks to them like the app refusing to let them in.
export async function smsQueueHealth() {
  const [pending, oldest] = await Promise.all([
    prisma.smsOutbox.count({ where: { status: 'pending' } }),
    prisma.smsOutbox.findFirst({
      where: { status: 'pending' },
      orderBy: { created_at: 'asc' },
      select: { created_at: true },
    }),
  ]);
  return {
    pending,
    oldestSeconds: oldest ? Math.round((Date.now() - oldest.created_at.getTime()) / 1000) : 0,
  };
}
