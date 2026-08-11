// Missed-call verification primitives. Pure domain logic — no DB, no Express, unit-testable.
//
// THE INVERSION: a passcode proves possession by sending a secret TO the phone and asking for
// it back. A missed call proves the same thing by having the phone reach US — the caller ID
// on an inbound call is the proof, and nothing is transmitted at all.
//
// That removes a whole class of failure (an A2P agreement we can't get, a SIM that looks like
// spam, a queue that silently backs up) and one class of attack (there is no code, so nobody
// can be talked into reading one out).
//
// The threat model this is written against:
//   * Challenge hijack  -> the TICKET. A session is handed only to the client that opened the
//                          challenge, never to "whoever asks about this number". Without this
//                          the whole scheme is broken — see the long comment on issueTicket.
//   * Offline cracking  -> tickets are scrypt-hashed at rest, exactly like passcodes: the
//                          table must not contain anything that grants a session if it leaks.
//   * Ticket guessing   -> 256 bits from crypto.randomBytes. Not user-typed, so unlike a
//                          6-digit code there is no usability reason to keep it short, and
//                          therefore no need for an attempt counter.
//   * Replay of a call  -> single-use. Verification consumes the challenge.
import crypto from 'node:crypto';

// A challenge is short-lived for the same reason a passcode is: it is a live credential.
// Longer than the 5-minute OTP window, because dialling and waiting for a ring is a slower
// physical act than reading a text — and a customer who has to redial should not find the
// challenge already dead.
export const CALL_CHALLENGE_TTL_MS = 10 * 60 * 1000;

// Minimum gap between two challenge opens for one number. Far shorter than the SMS cooldown
// (60s) because opening a challenge costs us NOTHING — no message, no money, no SIM quota.
// It exists only to stop a client hammering the endpoint, not to protect a budget.
export const CALL_RETRY_COOLDOWN_MS = 5 * 1000;

const TICKET_BYTES = 32;

// The client's claim on a challenge. Opaque, high-entropy, never shown to a human and never
// typed — so it is generated at full width rather than shortened for legibility.
export function generateTicket() {
  return crypto.randomBytes(TICKET_BYTES).toString('base64url');
}

// Shape check only, so a malformed ticket is rejected before it costs a scrypt. Never reveals
// whether a ticket is *live*, only whether it could be one.
export function isWellFormedTicket(ticket) {
  return typeof ticket === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(ticket);
}

export function hashTicket(ticket) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(ticket), salt, 32);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

// Constant-time comparison; returns false rather than throwing on a malformed stored value.
export function verifyTicket(ticket, stored) {
  if (typeof stored !== 'string') return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  let expected;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  const derived = crypto.scryptSync(String(ticket ?? ''), Buffer.from(saltHex, 'hex'), 32);
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

// WHY A TICKET AT ALL — the load-bearing idea, so nobody "simplifies" it away.
//
// With a passcode, an attacker who opens a challenge for someone else's number gets nothing:
// the code goes to the victim's handset and cannot be read from anywhere else.
//
// With a missed call there is no secret in flight. The attacker is waiting for *a call from
// that number to arrive*, which the victim may make for their own reasons. So the question is
// not "who knows the secret" but "who gets the session when the call lands", and the answer
// must be: only the client that opened this specific challenge and is holding its ticket.
//
// Consequences that must hold together with it:
//   * one live challenge per number, latest open WINS — so a victim starting their own
//     verification invalidates an attacker's challenge rather than racing it;
//   * a call matching no live challenge is DISCARDED, never remembered — otherwise a pool of
//     "already verified" numbers accumulates for a later challenge to draw on;
//   * verification is single-use.
export function issueTicket() {
  const ticket = generateTicket();
  return { ticket, ticketHash: hashTicket(ticket) };
}

export function challengeExpiryFrom(now = new Date()) {
  return new Date(now.getTime() + CALL_CHALLENGE_TTL_MS);
}

export function isExpired(expiresAt, now = Date.now()) {
  return new Date(expiresAt).getTime() <= now;
}

// How long a client should wait before polling again. Deliberately a server-supplied value:
// the pace of polling is a property of the flow, not something each client should invent.
export const CALL_POLL_INTERVAL_MS = 2000;
