// Staff onboarding by invite. Pure domain — no DB, no HTTP.
//
// The standard pattern for issuing staff credentials: an admin creates the account, the system
// texts the person a ONE-TIME setup code, and they choose their own PIN/password with it. So:
//   * the admin never knows the secret, and can't leak, reuse or be blamed for it;
//   * entering the code proves the person holds the phone on the request — something the
//     public request form alone cannot prove;
//   * nothing usable exists until they claim it. An invited account's stored secret is a
//     random hash nobody knows.
import crypto from 'node:crypto';

export const SETUP_CODE_LENGTH = 8;
// Long enough for someone to see the text and get to the app; short enough that a code in an
// old message thread is dead. Re-sending issues a fresh one.
export const SETUP_TTL_MS = 24 * 60 * 60 * 1000;
export const SETUP_MAX_ATTEMPTS = 5;
export const DRIVER_PIN_LENGTH = 6;

export function generateSetupCode() {
  return String(crypto.randomInt(0, 10 ** SETUP_CODE_LENGTH)).padStart(SETUP_CODE_LENGTH, '0');
}

export function isWellFormedSetupCode(code) {
  return typeof code === 'string' && new RegExp(`^\\d{${SETUP_CODE_LENGTH}}$`).test(code);
}

// A secret nobody knows, for an account that exists but hasn't been claimed. It has to be a
// valid hash (the column is NOT NULL and login runs verifySecret on it), and it must never
// match anything a person could type.
export function unclaimableSecret() {
  return crypto.randomBytes(32).toString('hex');
}

// Driver PINs chosen at setup. Six digits, and not the ones everybody picks first: a PIN is
// only one factor (the other is knowing the driver's number), so the obvious ones are out.
// Existing 4-digit PINs keep working at login — this only governs new ones.
export function validateDriverPin(raw) {
  const pin = String(raw ?? '');
  if (!new RegExp(`^\\d{${DRIVER_PIN_LENGTH}}$`).test(pin)) {
    return { valid: false, reason: `PIN must be exactly ${DRIVER_PIN_LENGTH} digits` };
  }
  if (/^(\d)\1+$/.test(pin)) return { valid: false, reason: 'PIN is too easy to guess' };
  const digits = [...pin].map(Number);
  const step = digits[1] - digits[0];
  const sequential = Math.abs(step) === 1 && digits.every((d, i) => i === 0 || d - digits[i - 1] === step);
  if (sequential) return { valid: false, reason: 'PIN is too easy to guess' };
  return { valid: true, pin };
}

// Suggest a username from a display name ("Amina Yusuf" -> "amina.yusuf"). Only a suggestion:
// the admin confirms it, and validateUsername() still has the final word.
export function suggestUsername(name) {
  const base = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 32);
  return base.length >= 3 ? base : '';
}

// The setup text. Bilingual — the person may read either — and in plain words. Kept to the
// code, how long it lasts and where to enter it; nothing that would help someone who
// intercepted it, and never the username for an operator (they learn it after setup).
export function setupMessage(role, code) {
  const en = role === 'driver' ? 'Driver' : 'Operator';
  const so = role === 'driver' ? 'Darawal' : 'Maamule';
  return (
    `GuriKaabe: your ${en.toLowerCase()} account is ready. Setup code ${code} (24h). ` +
    `App > ${en} > Set up account.\n` +
    `Koodhka: ${code}. App > ${so} > Samee akoonka.`
  );
}
