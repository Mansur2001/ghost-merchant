// Redaction helpers for anything that gets written to a log line.
//
// Logs are the one place where careful auth work quietly undoes itself: we spent P0 making
// phone numbers unreadable over the API, and a single `console.log(req.body)` would publish
// them to anyone with shell access, plus every log shipper and screen-share thereafter.
// Pure functions, no I/O — tested directly.

// Keep the country code and the last 3 digits: enough to correlate a support call with an
// order, not enough to dial the customer or identify them from a log dump.
export function maskPhone(phone) {
  if (typeof phone !== 'string' || phone.length === 0) return '';
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.length <= 7) return '•'.repeat(digits.length); // too short to partially reveal
  const head = digits.startsWith('+252') ? '+252' : digits.slice(0, 3);
  const tail = digits.slice(-3);
  const hidden = Math.max(0, digits.length - head.length - tail.length);
  return `${head}${'•'.repeat(hidden)}${tail}`;
}

// Stable, non-reversible label for "who made this request", safe to log and to store in the
// order_events audit trail.
export function actorLabel(auth) {
  if (!auth || !auth.role) return 'anon';
  switch (auth.role) {
    case 'customer':
      return `customer:${maskPhone(auth.phone)}`;
    case 'driver':
      return `driver:${auth.id}`;
    case 'operator':
      // Named operator (P0 #5) — the audit trail must say WHO, not "the operator".
      return auth.username ? `operator:${auth.id}:${auth.username}` : `operator:${auth.id}`;
    default:
      return 'unknown';
  }
}

// Keys whose values must never appear in a log, whatever the shape of the payload.
const SECRET_KEYS = new Set([
  'token', 'password', 'pin', 'code', 'devcode', 'secret', 'authorization',
  'pin_hash', 'password_hash', 'code_hash', 'newpassword', 'currentpassword',
]);
const PHONE_KEYS = new Set(['phone', 'msisdn', 'user_phone', 'userphone', 'sender_msisdn', 'to']);

// Deep-redact an arbitrary object before logging it. Depth-limited so a hostile or cyclic
// payload can't turn logging into a stack overflow.
export function redact(value, depth = 0) {
  if (depth > 4) return '[deep]';
  if (value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const key = k.toLowerCase();
      if (SECRET_KEYS.has(key)) out[k] = '[redacted]';
      else if (PHONE_KEYS.has(key)) out[k] = typeof v === 'string' ? maskPhone(v) : '[redacted]';
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  return value;
}

// Paths whose request bodies are never logged at all, even redacted — belt and braces around
// the two endpoints that carry live login secrets.
export function isSensitivePath(path) {
  return /\/(auth\/otp|login|password)/.test(path || '');
}
