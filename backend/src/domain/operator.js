// Operator account rules. Pure domain — no DB, no Express.
//
// The operator desk is the highest-privilege surface in the system (it reads every order and
// can drive every state machine), so the account rules are stricter than the driver PIN's:
// a PIN is protected by also needing the physical phone and a rate limiter, while an operator
// password is the entire perimeter until 2FA exists.

export const MIN_PASSWORD_LENGTH = 12;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;

// Usernames are case- and whitespace-insensitive for login: "Amina " and "amina" must not be
// two different accounts, or an attacker can register a lookalike of a real operator.
export function normalizeUsername(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

export function validateUsername(raw) {
  const username = normalizeUsername(raw);
  if (!username) return { valid: false, reason: 'username required' };
  if (!USERNAME_RE.test(username)) {
    return {
      valid: false,
      reason: 'username must be 3-32 chars: letters, digits, dot, dash or underscore',
    };
  }
  return { valid: true, username };
}

// Length over composition rules: a 12-char passphrase beats "P@ss1!" and people actually
// remember it instead of writing it on the desk. We only reject what is outright dangerous.
export function validatePassword(raw, { username } = {}) {
  const password = String(raw ?? '');
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, reason: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (password.length > 200) return { valid: false, reason: 'password too long' };
  if (username && password.toLowerCase().includes(normalizeUsername(username))) {
    return { valid: false, reason: 'password must not contain the username' };
  }
  if (/^\s+$/.test(password)) return { valid: false, reason: 'password must not be blank' };
  return { valid: true, password };
}
