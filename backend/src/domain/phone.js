// Phone number normalization + validation. The phone number IS the customer identity
// (invariant 4), so this is a trust boundary: everything stored is canonical E.164.
//
// Two countries are supported, for different reasons:
//
//   SO (+252) — the real market. 2-digit operator prefix + 7 subscriber digits = 9-digit
//               national number (matches the SRS's "61XXXXXXX"). These numbers can pay by
//               USSD (EVC Plus / eDahab).
//   US (+1)   — so the app can be developed and tested end-to-end on a North American
//               handset. A +1 number CANNOT pay by USSD: EVC Plus is a Somali telecom rail
//               and has no NANP equivalent. Those orders fall back to the operator's manual
//               "mark as paid" path. See `canUssd` — never assume a valid number can pay.
//
// `frontend/shared/phone.js` is the browser mirror for live input feedback; THIS file is the
// enforced source of truth. Keep the two country tables in sync.
//
// Sources (operators occasionally reallocate ranges — validity is strict, operator tag
// is best-effort):
//   - NCA National Telephone Numbering Plan (2021):
//     https://nca.gov.so/wp-content/uploads/2021/12/Numbering-Plan-Somalia-Clean-BV-Final-1.pdf
//   - https://en.wikipedia.org/wiki/Telephone_numbers_in_Somalia
//   - NANP: https://en.wikipedia.org/wiki/North_American_Numbering_Plan

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

const SO_SUBSCRIBER_DIGITS = 7;
const SO_NATIONAL_LENGTH = 2 + SO_SUBSCRIBER_DIGITS; // 9
const US_NATIONAL_LENGTH = 10;

// NANP: area code and exchange code both start 2-9; neither may start 0 or 1.
const US_NATIONAL_RE = /^[2-9]\d{2}[2-9]\d{6}$/;

export const COUNTRIES = {
  SO: { code: '252', nationalLength: SO_NATIONAL_LENGTH, canUssd: true },
  US: { code: '1', nationalLength: US_NATIONAL_LENGTH, canUssd: false },
};

function digitsOnly(raw) {
  return String(raw ?? '').replace(/[^\d]/g, '');
}

// Work out which country a number belongs to, and its national part.
//
// A BARE number (no country code) is always read as Somali. US numbers REQUIRE an explicit
// +1 / 1 / 001 prefix.
//
// This asymmetry is deliberate and worth the small inconvenience to the tester. If bare
// 10-digit input were accepted as US, then a Somali customer fat-fingering one extra digit
// — "6123456789" instead of "612345678" — would silently become a perfectly valid US
// number (area 612, exchange 345). They'd receive no SMS code, or worse, create an order
// under an identity that isn't theirs and whose payment can never match. Somalia is the
// product; +1 is a development affordance. The product must not pay for the affordance.
function splitCountry(raw) {
  const s = String(raw ?? '').trim();
  let digits = digitsOnly(s);
  const hadIntlPrefix = s.startsWith('+') || digits.startsWith('00');
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (digits.startsWith('252') && digits.length === 3 + SO_NATIONAL_LENGTH) {
    return { country: 'SO', national: digits.slice(3) };
  }
  // Explicit US: "+1XXXXXXXXXX", "1XXXXXXXXXX" or "001XXXXXXXXXX". Somali national numbers
  // are 9 digits and never start with 1, so this cannot capture one.
  if (digits.startsWith('1') && digits.length === 1 + US_NATIONAL_LENGTH) {
    return { country: 'US', national: digits.slice(1), explicit: true };
  }
  // Somali numbers are commonly written with a trunk 0 (061...). Strip it before measuring.
  if (digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length === SO_NATIONAL_LENGTH) return { country: 'SO', national: digits };

  return { country: null, national: digits, hadIntlPrefix };
}

// Returns { valid, e164, national, country, prefix, operator, canUssd, reason }.
export function parsePhone(raw) {
  const original = digitsOnly(raw);
  if (!original) return { valid: false, reason: 'empty' };

  const { country, national } = splitCountry(raw);

  if (!country) {
    // A bare 10-digit string is the classic "typed a US number without +1" case. Say that
    // explicitly rather than leaving the tester to guess at a length complaint.
    const hint =
      national.length === US_NATIONAL_LENGTH
        ? ' — for a US number include the country code (+1)'
        : '';
    return {
      valid: false,
      national,
      reason: `expected ${SO_NATIONAL_LENGTH} digits (Somalia), got ${national.length}${hint}`,
    };
  }

  if (country === 'SO') {
    const prefix = national.slice(0, 2);
    const operator = PREFIX_TO_OPERATOR[prefix];
    if (!operator) {
      return { valid: false, country, national, prefix, reason: `unknown operator prefix "${prefix}"` };
    }
    return {
      valid: true,
      country,
      national,
      prefix,
      operator,
      canUssd: true,
      e164: `+252${national}`,
    };
  }

  // US
  if (!US_NATIONAL_RE.test(national)) {
    return {
      valid: false,
      country,
      national,
      reason: 'not a valid US number (area code and exchange must start 2-9)',
    };
  }
  return {
    valid: true,
    country,
    national,
    prefix: national.slice(0, 3),
    operator: 'US / Canada',
    // The honest part: this number can hold an account and receive an SMS code, but it
    // cannot pay over EVC Plus. The UI must say so rather than showing a dead pay button.
    canUssd: false,
    e164: `+1${national}`,
  };
}

// Throw on invalid, else return canonical E.164. Use at every trust boundary.
export function normalizeMsisdnOrThrow(raw) {
  const r = parsePhone(raw);
  if (!r.valid) throw new Error(`Invalid phone number: ${r.reason}`);
  return r.e164;
}

// Can this number pay via the USSD bridge? Somalia only.
export function canPayByUssd(raw) {
  const r = parsePhone(raw);
  return Boolean(r.valid && r.canUssd);
}
