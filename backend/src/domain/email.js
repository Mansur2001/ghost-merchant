// Email addresses: an optional second way to receive a code. Never an identity — a customer is
// still their phone number (invariant 4); an email only becomes usable for sign-in after it was
// confirmed by a signed-in customer (commands/auth.js).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Canonical form, or null. Lowercased so "Amina@Gmail.com" and "amina@gmail.com" are one
// address; length-capped at the RFC limit so it can't be used to stuff the database.
export function normalizeEmail(raw) {
  const e = String(raw ?? '').trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

// For logs: "am•••@gmail.com". Logs must never undo the API's privacy (domain/redact.js).
export function maskEmail(email) {
  const [user, domain] = String(email ?? '').split('@');
  if (!domain) return '•••';
  return `${user.slice(0, 2)}•••@${domain}`;
}
