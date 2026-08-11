// Missed-call verification primitives.
//
// The property under test throughout is the TICKET, because it is the only thing standing
// between this scheme and "anyone who knows your phone number can collect the session you
// just earned by calling in". With a passcode the secret travels to the handset; here nothing
// travels at all, so the client's claim on the challenge is the whole security argument.
import {
  generateTicket,
  isWellFormedTicket,
  hashTicket,
  verifyTicket,
  issueTicket,
  challengeExpiryFrom,
  isExpired,
  CALL_CHALLENGE_TTL_MS,
  CALL_RETRY_COOLDOWN_MS,
} from '../src/domain/callChallenge.js';

describe('ticket generation', () => {
  test('tickets are unguessable and unique', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(generateTicket());
    expect(seen.size).toBe(500);
  });

  test('a ticket carries far more entropy than a 6-digit code', () => {
    // A passcode is short because a human types it, and that shortness is why it needs an
    // attempt counter. A ticket is never typed, so there is no reason to weaken it — and
    // therefore no need to cap attempts against it.
    const ticket = generateTicket();
    expect(ticket.length).toBeGreaterThanOrEqual(40);
  });

  test('generated tickets are well-formed', () => {
    for (let i = 0; i < 50; i++) expect(isWellFormedTicket(generateTicket())).toBe(true);
  });

  test('rejects shapes that could never be a real ticket', () => {
    expect(isWellFormedTicket('')).toBe(false);
    expect(isWellFormedTicket('short')).toBe(false);
    expect(isWellFormedTicket(null)).toBe(false);
    expect(isWellFormedTicket(12345)).toBe(false);
    expect(isWellFormedTicket('a'.repeat(200))).toBe(false);
    // Characters outside base64url would mean something other than our generator made it.
    expect(isWellFormedTicket('!'.repeat(48))).toBe(false);
  });
});

describe('ticket hashing', () => {
  test('the stored form never contains the ticket', () => {
    const ticket = generateTicket();
    const stored = hashTicket(ticket);
    expect(stored).not.toContain(ticket);
  });

  test('the same ticket hashes differently each time (per-ticket salt)', () => {
    const ticket = generateTicket();
    expect(hashTicket(ticket)).not.toBe(hashTicket(ticket));
  });

  test('a correct ticket verifies against its own hash', () => {
    const { ticket, ticketHash } = issueTicket();
    expect(verifyTicket(ticket, ticketHash)).toBe(true);
  });

  test('a different ticket does not', () => {
    const { ticketHash } = issueTicket();
    expect(verifyTicket(generateTicket(), ticketHash)).toBe(false);
  });

  test('malformed stored values return false rather than throwing', () => {
    // A crash here would be a 500 that distinguishes a corrupt row from a wrong ticket.
    const ticket = generateTicket();
    expect(verifyTicket(ticket, null)).toBe(false);
    expect(verifyTicket(ticket, '')).toBe(false);
    expect(verifyTicket(ticket, 'nocolon')).toBe(false);
    expect(verifyTicket(ticket, ':')).toBe(false);
    expect(verifyTicket(ticket, 'zz:zz')).toBe(false);
    expect(verifyTicket(ticket, undefined)).toBe(false);
  });

  test('null and undefined tickets never verify', () => {
    const { ticketHash } = issueTicket();
    expect(verifyTicket(null, ticketHash)).toBe(false);
    expect(verifyTicket(undefined, ticketHash)).toBe(false);
    expect(verifyTicket('', ticketHash)).toBe(false);
  });
});

describe('expiry', () => {
  test('a fresh challenge is not expired', () => {
    expect(isExpired(challengeExpiryFrom())).toBe(false);
  });

  test('a challenge dies after its TTL', () => {
    const issued = new Date(Date.now() - CALL_CHALLENGE_TTL_MS - 1000);
    expect(isExpired(challengeExpiryFrom(issued))).toBe(true);
  });

  test('expiry is inclusive at the boundary', () => {
    // A credential exactly at its deadline is dead, not alive.
    const now = Date.now();
    expect(isExpired(new Date(now), now)).toBe(true);
  });

  test('the window is longer than the SMS one, because dialling is slower than reading', () => {
    // A customer who has to redial must not find the challenge already dead.
    expect(CALL_CHALLENGE_TTL_MS).toBeGreaterThan(5 * 60 * 1000);
  });
});

describe('cooldown', () => {
  test('is short, because opening a challenge costs nothing', () => {
    // The SMS cooldown is 60s and protects real money and SIM quota. Nothing is sent here,
    // so this exists only to stop a client spinning the endpoint.
    expect(CALL_RETRY_COOLDOWN_MS).toBeLessThan(60 * 1000);
    expect(CALL_RETRY_COOLDOWN_MS).toBeGreaterThan(0);
  });
});
