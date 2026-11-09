// Customer sessions that can be ended early.
//
// A customer token lives 30 days and is checked by signature alone, so on its own nothing can
// cancel it. Each one now carries the account's session version (`sv`), and a token is good
// only while that still equals `users.session_version`. Raising the version — a password set,
// changed or reset; a squatter's password removed — signs out every device holding an older
// token at once (OWASP: end other sessions on a password change). The device that made the
// change is handed a new token in the same response.
//
// Tokens from before this existed carry no `sv`: that reads as 0, the column's default, so
// deploying this signed nobody out.
//
// Read on every customer request, so it is cached briefly. The cache is corrected at once on
// this instance when the version changes, and on every other instance by the outbox event
// (the socket layer listens for it) — a revoked token survives seconds at most, never days.
import { prisma } from '../db/prisma.js';
import { enqueue } from '../events/outbox.js';
import { EVENTS } from '../events/bus.js';

const CACHE_MS = 10 * 1000;
const CACHE_MAX = 5000;
const cache = new Map(); // uid -> { sv, at }

export function noteSessionVersion(uid, sv) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(uid, { sv, at: Date.now() });
}

// The account's current version, or null if the account doesn't exist.
async function currentVersion(uid) {
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.sv;
  const u = await prisma.user.findUnique({ where: { id: uid }, select: { session_version: true } });
  if (!u) return null;
  noteSessionVersion(uid, u.session_version);
  return u.session_version;
}

// Is this (already signature-checked) token still a live session? Staff tokens aren't
// versioned (12 hours, and their own reset path), so they always pass here.
export async function sessionIsCurrent(payload) {
  if (payload?.role !== 'customer') return true;
  const v = await currentVersion(payload.uid);
  return v !== null && (Number.isInteger(payload.sv) ? payload.sv : 0) === v;
}

// Inside the caller's transaction: end every session of this account and say so (the event
// closes their open sockets). Returns the new version, for the token the caller hands back.
// After COMMIT the caller should noteSessionVersion() and wakeOutbox().
export async function endSessions(tx, uid) {
  const { session_version: sv } = await tx.user.update({
    where: { id: uid },
    data: { session_version: { increment: 1 } },
    select: { session_version: true },
  });
  await enqueue(tx, EVENTS.CUSTOMER_SESSIONS_ENDED, { uid, sv });
  return sv;
}

export function resetSessionCache() {
  cache.clear();
}
