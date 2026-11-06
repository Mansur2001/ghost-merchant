// Customer password rules. Pure, so they're testable. Deliberately humane: length beats
// composition rules, and we refuse only what is outright guessable — this is a delivery app
// used on cheap phones, not a bank, and a rule people can't meet sends them back to email codes.
export const MIN_LENGTH = 8;
export const MAX_LENGTH = 128;

// The handful attackers try first. Not a full dictionary: rate limits do the rest.
const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', '87654321',
  'qwertyui', 'qwerty123', 'iloveyou', 'abcdefgh', 'abcd1234', '11111111', '00000000',
  'gurikaabe', 'somalia1', 'mogadishu', 'muqdisho',
]);

// null when acceptable, otherwise the reason (shown to the customer, so it is plain).
export function passwordProblem(password, { email } = {}) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) return `use at least ${MIN_LENGTH} characters`;
  if (password.length > MAX_LENGTH) return 'that password is too long';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'that password is too easy to guess';
  if (/^(.)\1+$/.test(password)) return 'that password is too easy to guess';
  const local = String(email || '').toLowerCase().split('@')[0];
  if (local.length >= 4 && lower.includes(local)) return 'don’t use your email in your password';
  return null;
}
