// CQRS write side for missed-call verification.
//
// The customer's phone number IS their identity (invariant 4). This is the second way to turn
// "a number someone typed" into "a number someone can prove they hold" — the first being an
// SMS passcode (commands/auth.js). Both mint the same claim and the same session token; they
// differ only in how possession is demonstrated.
//
// Nothing here sends anything. That is the entire point: no A2P agreement, no SIM quota, no
// queue to back up, no plaintext credential stored anywhere, and no code for a caller
// pretending to be support to ask for.
import { prisma, withTransaction } from '../db/prisma.js';
import { normalizeMsisdnOrThrow } from '../domain/phone.js';
import {
  issueTicket,
  verifyTicket,
  challengeExpiryFrom,
  isExpired,
  CALL_CHALLENGE_TTL_MS,
  CALL_RETRY_COOLDOWN_MS,
} from '../domain/callChallenge.js';
import { config } from '../config.js';

export class CallVerificationUnavailableError extends Error {
  constructor() {
    super('call verification is not available');
    this.status = 503;
  }
}

// One generic error for every failure of a poll, for the same reason verifyOtp has one: the
// difference between "no such challenge", "expired" and "wrong ticket" would turn the polling
// endpoint into an oracle for which numbers are mid-signup.
export class CallChallengeInvalidError extends Error {
  constructor() {
    super('invalid or expired verification');
    this.status = 401;
  }
}

export function callVerificationNumber() {
  return config.verifyCall.number || '';
}

export function isCallVerificationConfigured() {
  return !!callVerificationNumber();
}

// Open (or re-open) a challenge for a number, returning the ticket that claims it.
//
// The UPSERT is conditional on a short cooldown, matching requestOtp's shape — but note the
// asymmetry in WHY. There, the cooldown protects money and SIM quota, because each request
// sends a real message. Here nothing is sent, so it exists only to stop a client spinning the
// endpoint; it is seconds rather than a minute.
export async function startCallChallenge(rawPhone) {
  if (!isCallVerificationConfigured()) throw new CallVerificationUnavailableError();

  const phone = normalizeMsisdnOrThrow(rawPhone);
  const { ticket, ticketHash } = issueTicket();
  const cooldownSeconds = Math.ceil(CALL_RETRY_COOLDOWN_MS / 1000);
  const ttlSeconds = Math.ceil(CALL_CHALLENGE_TTL_MS / 1000);

  // RAW, and it must stay raw: a CONDITIONAL upsert. Prisma's upsert has no WHERE on its
  // update branch, so the equivalent is read-then-write — and two concurrent opens would both
  // decide they had won and mint two tickets for one number, leaving a live ticket the
  // customer's own client is not holding.
  //
  // LATEST OPEN WINS is a security property, not a convenience: it is what guarantees a
  // victim starting their own verification invalidates an attacker's challenge for the same
  // number, rather than the two sitting side by side waiting for the same call.
  const rows = await prisma.$queryRaw`
    INSERT INTO call_challenges(phone, ticket_hash, expires_at, verified_at, last_open_at)
    VALUES (${phone}, ${ticketHash},
            now() + (${String(ttlSeconds)} || ' seconds')::interval, NULL, now())
    ON CONFLICT (phone) DO UPDATE
      SET ticket_hash  = EXCLUDED.ticket_hash,
          expires_at   = EXCLUDED.expires_at,
          verified_at  = NULL,
          last_open_at = now()
      WHERE call_challenges.last_open_at <= now() - (${String(cooldownSeconds)} || ' seconds')::interval
    RETURNING phone
  `;

  if (rows.length === 0) {
    // Someone opened a challenge for this number moments ago. Say only "slow down" — whether
    // that was this client or another one is not information we should hand out.
    const err = new Error('a verification was just started — try again in a moment');
    err.status = 429;
    err.retryAfterMs = CALL_RETRY_COOLDOWN_MS;
    throw err;
  }

  return {
    phone,
    ticket,
    callNumber: callVerificationNumber(),
    expiresInSeconds: ttlSeconds,
  };
}

// An inbound call the Oracle observed. Returns what happened, for the device's log only —
// the customer learns the outcome by polling, never from this path.
//
// A call that matches no live challenge is DISCARDED. It must never be recorded "in case a
// challenge appears later": that would let an attacker open a challenge for a number that had
// merely called us at some point in the past and have it resolve instantly.
export async function recordInboundCall({ from, at }) {
  let phone;
  try {
    phone = normalizeMsisdnOrThrow(from);
  } catch {
    return { matched: false, reason: 'unparseable_caller_id' };
  }

  return withTransaction(async (tx) => {
    // RAW, and it must stay raw: FOR UPDATE. Without the lock a repeated call report and a
    // poll can interleave, and the challenge can be marked verified twice — harmless today,
    // but the lock is also what makes "single-use" mean anything if this grows a consumer.
    const rows = await tx.$queryRaw`
      SELECT phone, expires_at, verified_at FROM call_challenges
       WHERE phone = ${phone} FOR UPDATE
    `;
    const challenge = rows[0];
    if (!challenge) return { matched: false, reason: 'no_live_challenge' };

    if (isExpired(challenge.expires_at)) {
      await tx.callChallenge.deleteMany({ where: { phone } });
      return { matched: false, reason: 'expired' };
    }

    if (!challenge.verified_at) {
      await tx.callChallenge.update({
        where: { phone },
        data: { verified_at: at ? new Date(at) : new Date() },
      });
    }
    return { matched: true };
  });
}

// The client asks "has my call landed yet?", presenting the ticket it was issued.
//
// Success CONSUMES the challenge, so a leaked ticket cannot be replayed into a second session,
// and creates the customer row — the phone becomes a real identity at exactly this point,
// same as verifyOtp.
export async function pollCallChallenge(rawPhone, ticket) {
  const phone = normalizeMsisdnOrThrow(rawPhone);

  return withTransaction(async (tx) => {
    const rows = await tx.$queryRaw`
      SELECT phone, ticket_hash, expires_at, verified_at FROM call_challenges
       WHERE phone = ${phone} FOR UPDATE
    `;
    const challenge = rows[0];
    if (!challenge) throw new CallChallengeInvalidError();

    if (isExpired(challenge.expires_at)) {
      await tx.callChallenge.deleteMany({ where: { phone } });
      throw new CallChallengeInvalidError();
    }

    // THE CHECK THE SCHEME RESTS ON. Not "is this number verified" — "is this the client that
    // opened this challenge". Dropping it would let anyone who knows a phone number poll it
    // and collect the session that number's owner just earned by calling in.
    if (!verifyTicket(String(ticket ?? ''), challenge.ticket_hash)) {
      throw new CallChallengeInvalidError();
    }

    if (!challenge.verified_at) return { status: 'pending', phone };

    await tx.callChallenge.deleteMany({ where: { phone } });
    await tx.user.upsert({
      where: { phone_number: phone },
      update: {},
      create: { phone_number: phone },
    });
    return { status: 'verified', phone };
  });
}

// Housekeeping, same rationale as sweepExpiredOtps: an expired challenge is dead weight and
// PII-adjacent (it is a phone number mid-signup).
export async function sweepExpiredCallChallenges() {
  const { count } = await prisma.callChallenge.deleteMany({
    where: { expires_at: { lt: new Date() } },
  });
  return count;
}
