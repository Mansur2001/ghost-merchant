// Somali mobile number normalization + strict per-operator validation. Server-side
// enforcement mirror of frontend/shared/phone.js — the backend is the source of truth,
// the frontend copy just gives live keystroke feedback.
//
// Format: 2-digit operator prefix + 7 subscriber digits = 9-digit national number
// (matches the SRS's own "61XXXXXXX" / EVC Plus format). Canonical E.164: +252XXXXXXXXX.
//
// Sources (operators occasionally reallocate ranges — validity is strict, operator tag
// is best-effort):
//   - NCA National Telephone Numbering Plan (2021):
//     https://nca.gov.so/wp-content/uploads/2021/12/Numbering-Plan-Somalia-Clean-BV-Final-1.pdf
//   - https://en.wikipedia.org/wiki/Telephone_numbers_in_Somalia

export const PREFIX_TO_OPERATOR = {
  '61': 'Hormuud',
  '62': 'Hormuud',
  '77': 'Hormuud',
  '65': 'Somtel',
  '66': 'Somtel',
  '68': 'Somtel',
  '63': 'Telesom',
  '64': 'SomLink',
  '67': 'NationLink',
  '69': 'NationLink',
  '71': 'Amtel',
  '90': 'Golis',
};

const SUBSCRIBER_DIGITS = 7;

function toNational(raw) {
  if (raw == null) return '';
  let s = String(raw).replace(/[^\d]/g, '');
  if (s.startsWith('00252')) s = s.slice(5);
  else if (s.startsWith('252')) s = s.slice(3);
  else if (s.startsWith('0')) s = s.slice(1);
  return s;
}

// Returns { valid, e164, national, prefix, operator, reason }.
export function parseSomaliMsisdn(raw) {
  const national = toNational(raw);
  if (!national) return { valid: false, reason: 'empty' };
  if (!/^\d+$/.test(national)) return { valid: false, reason: 'non-numeric' };

  const prefix = national.slice(0, 2);
  const operator = PREFIX_TO_OPERATOR[prefix];
  if (!operator) {
    return { valid: false, national, prefix, reason: `unknown operator prefix "${prefix}"` };
  }
  if (national.length !== 2 + SUBSCRIBER_DIGITS) {
    return {
      valid: false,
      national,
      prefix,
      operator,
      reason: `expected ${2 + SUBSCRIBER_DIGITS} digits, got ${national.length}`,
    };
  }
  return { valid: true, national, prefix, operator, e164: `+252${national}` };
}

// Throw on invalid, else return canonical E.164. Use at every trust boundary.
export function normalizeMsisdnOrThrow(raw) {
  const r = parseSomaliMsisdn(raw);
  if (!r.valid) throw new Error(`Invalid Somali phone number: ${r.reason}`);
  return r.e164;
}
