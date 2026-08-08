// Order identifiers. Pure helpers — no DB, no Express.
//
// Order ids are UUIDs (migration 006). Two consequences the rest of the code depends on:
//   * A malformed id must be rejected BEFORE it reaches Postgres. `SELECT ... WHERE id = 'abc'`
//     raises 22P02 (invalid input syntax for uuid), which would surface as a 500 — an error
//     class that says "the server is broken" when the truth is "you sent nonsense".
//   * Clients may generate their own (offline order creation, and idempotent retries), so
//     anything arriving from a client is untrusted input and gets shape-checked here.
import crypto from 'node:crypto';

// Accepts any RFC-4122 variant. We mint v4, but refusing a client's v7 (which sorts better
// and is a reasonable thing for a mobile client to use) would be gratuitous.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function newOrderId() {
  return crypto.randomUUID();
}

// Short display form. A full UUID is unreadable on a phone screen and unusable over the
// phone ("read me your order number"), so the UI shows the first block. Collisions within
// one customer's handful of orders are not a practical concern, and every lookup still uses
// the full id — this is presentation only, never an identifier.
export function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 8) : '';
}
