// What a job costs. Pure: the server prices every order from these rules and the catalog, and
// never from a number the client sent. (Before this, the customer typed their own total.)
//
// All arithmetic is in whole cents. A float total like 0.1 + 0.2 must never reach a
// payment comparison that is exact to the cent (commands/payments.js).

export const VEHICLES = ['bajaj', 'car'];

// Defaults, in US dollars (what Somali mobile money is denominated in). Each can be overridden
// by env at boot (parseTariff), so the owner can change a fare without a release.
export const DEFAULT_TARIFF = {
  ride: {
    bajaj: { base: 1.0, perKm: 0.4, min: 1.5 },
    car: { base: 2.0, perKm: 0.7, min: 3.0 },
  },
  delivery: { base: 1.0, perKm: 0.3, freeKm: 2, min: 1.0 },
  // Further than this and it isn't a city job: refuse rather than quote a fare nobody expects.
  maxRideKm: 50,
  maxDeliveryKm: 30,
};

export const MAX_CART_LINES = 30;
export const MAX_QTY = 50;
export const CUSTOM_TEXT_MAX = 300;
export const CUSTOM_BUDGET_MIN = 0.5;
export const CUSTOM_BUDGET_MAX = 500;

export class PricingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const toCents = (v) => Math.round(Number(v) * 100);
export const fromCents = (c) => (c / 100).toFixed(2);

// Fares end in a whole 10 cents: easier to read, and to type into a USSD menu.
const roundUpTo10 = (cents) => Math.ceil(cents / 10) * 10;

// Pure: the tariff from env, with every problem collected so boot can print them at once.
const ENV_KEYS = [
  ['RIDE_BAJAJ_BASE', ['ride', 'bajaj', 'base']],
  ['RIDE_BAJAJ_PER_KM', ['ride', 'bajaj', 'perKm']],
  ['RIDE_BAJAJ_MIN', ['ride', 'bajaj', 'min']],
  ['RIDE_CAR_BASE', ['ride', 'car', 'base']],
  ['RIDE_CAR_PER_KM', ['ride', 'car', 'perKm']],
  ['RIDE_CAR_MIN', ['ride', 'car', 'min']],
  ['DELIVERY_BASE', ['delivery', 'base']],
  ['DELIVERY_PER_KM', ['delivery', 'perKm']],
  ['DELIVERY_FREE_KM', ['delivery', 'freeKm']],
  ['DELIVERY_MIN', ['delivery', 'min']],
];

export function parseTariff(env) {
  const tariff = structuredClone(DEFAULT_TARIFF);
  const errors = [];
  for (const [key, path] of ENV_KEYS) {
    const raw = (env[key] || '').trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1000) {
      errors.push(`${key} must be a number of dollars between 0 and 1000 (got "${raw}")`);
      continue;
    }
    let node = tariff;
    for (const p of path.slice(0, -1)) node = node[p];
    node[path[path.length - 1]] = n;
  }
  return { tariff, errors };
}

// Fare for a ride of `meters` in `vehicle`. Returns cents.
export function rideFareCents(meters, vehicle, tariff = DEFAULT_TARIFF) {
  const t = tariff.ride[vehicle];
  if (!t) throw new PricingError('choose bajaj or car');
  if (meters > tariff.maxRideKm * 1000) throw new PricingError('that trip is too far for a city ride');
  const raw = toCents(t.base) + Math.round((meters / 1000) * toCents(t.perKm));
  return roundUpTo10(Math.max(raw, toCents(t.min)));
}

// Delivery fee from the market to the door. The first `freeKm` are in the base fee.
export function deliveryFeeCents(meters, tariff = DEFAULT_TARIFF) {
  const t = tariff.delivery;
  if (meters > tariff.maxDeliveryKm * 1000) throw new PricingError('that address is too far from the market');
  const chargedKm = Math.max(0, meters / 1000 - t.freeKm);
  const raw = toCents(t.base) + Math.round(chargedKm * toCents(t.perKm));
  return roundUpTo10(Math.max(raw, toCents(t.min)));
}

// Validate a cart against the catalog and price it. `catalog` is a Map of item id -> active
// item row ({ id, name_en, name_so, unit_en, unit_so, price }).
//
// lines:  [{ itemId, qty }]  — duplicates are merged, so a double tap is one line of 2
// custom:  { text, budget }  — something not in the catalog. `budget` is what the customer
//                              allows the driver to spend on it; a photo can go with it.
//
// Returns { items, subtotalCents } where `items` is what the order row stores. Every line
// carries `text`, which is what older app builds display.
export function priceCart({ lines = [], custom = null }, catalog) {
  if (!Array.isArray(lines)) throw new PricingError('items must be a list');
  if (lines.length > MAX_CART_LINES) throw new PricingError(`at most ${MAX_CART_LINES} different items`);

  const qtyById = new Map();
  for (const line of lines) {
    const id = Number(line?.itemId);
    const qty = Number(line?.qty);
    if (!Number.isInteger(id) || id <= 0) throw new PricingError('unknown item');
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      throw new PricingError(`quantity must be 1 to ${MAX_QTY}`);
    }
    qtyById.set(id, (qtyById.get(id) || 0) + qty);
  }

  const items = [];
  let subtotal = 0;
  for (const [id, qty] of qtyById) {
    const item = catalog.get(id);
    // Removed or hidden since the customer loaded the menu: refuse, so they never pay for a
    // line the driver can't buy.
    if (!item) throw new PricingError('an item in your cart is no longer available', 409);
    if (qty > MAX_QTY) throw new PricingError(`quantity must be 1 to ${MAX_QTY}`);
    const unit = toCents(item.price);
    const line = unit * qty;
    subtotal += line;
    const unitLabel = item.unit_en ? ` (${item.unit_en})` : '';
    items.push({
      item_id: item.id,
      name_en: item.name_en,
      name_so: item.name_so,
      unit_en: item.unit_en || '',
      unit_so: item.unit_so || '',
      qty,
      unit_price: fromCents(unit),
      line_total: fromCents(line),
      text: `${qty} × ${item.name_en}${unitLabel}`,
    });
  }

  if (custom != null && custom !== '') {
    const text = typeof custom.text === 'string' ? custom.text.trim() : '';
    const budget = Number(custom.budget);
    if (text.length < 2) throw new PricingError('describe what you want');
    if (text.length > CUSTOM_TEXT_MAX) throw new PricingError(`keep the description under ${CUSTOM_TEXT_MAX} characters`);
    if (!Number.isFinite(budget) || budget < CUSTOM_BUDGET_MIN || budget > CUSTOM_BUDGET_MAX) {
      throw new PricingError(`the budget must be $${CUSTOM_BUDGET_MIN.toFixed(2)} to $${CUSTOM_BUDGET_MAX}`);
    }
    const cents = toCents(budget);
    subtotal += cents;
    items.push({ custom: true, text, budget: fromCents(cents), line_total: fromCents(cents) });
  }

  if (!items.length) throw new PricingError('your cart is empty');
  return { items, subtotalCents: subtotal };
}
