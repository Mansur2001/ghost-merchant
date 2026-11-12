// Admin settings: today only the free-delivery promo. Every change is audited (a waived fee is
// money the business chose not to take), and read through a short cache — checkout reads it
// on every quote.
import { prisma } from '../db/prisma.js';
import { audit } from './audit.js';

export class SettingsError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const DEFAULTS = {
  free_delivery: { enabled: false, minSubtotal: '0.00' },
};

const cache = new Map();
const TTL_MS = 10_000;

export async function getSetting(key) {
  if (!(key in DEFAULTS)) throw new SettingsError('unknown setting', 404);
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - TTL_MS) return hit.value;
  const row = await prisma.appSetting.findUnique({ where: { key } });
  const value = { ...DEFAULTS[key], ...(row?.value || {}) };
  cache.set(key, { value, at: Date.now() });
  return value;
}

function validate(key, body) {
  if (key === 'free_delivery') {
    if (typeof body?.enabled !== 'boolean') throw new SettingsError('enabled must be true or false');
    const min = Number(body.minSubtotal ?? 0);
    if (!Number.isFinite(min) || min < 0 || min > 1000) throw new SettingsError('the minimum is $0 to $1000');
    return { enabled: body.enabled, minSubtotal: min.toFixed(2) };
  }
  throw new SettingsError('unknown setting', 404);
}

export async function setSetting(key, body, actor) {
  const value = validate(key, body);
  const before = await getSetting(key);
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value, updated_by: actor },
    update: { value, updated_by: actor, updated_at: new Date() },
  });
  cache.delete(key);
  await audit({ actor, action: 'settings.updated', subject: `setting:${key}`, detail: { from: before, to: value } });
  return value;
}

// The public part, for the customer app's banner.
export async function publicSettings() {
  return { freeDelivery: await getSetting('free_delivery') };
}
