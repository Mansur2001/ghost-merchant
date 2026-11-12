// Admin edits to the catalog and the places list. Every change is audited: a price is what
// customers are charged, and "who changed rice to $9" must have an answer.
import { prisma } from '../db/prisma.js';
import { audit } from './audit.js';
import { randomBytes } from 'node:crypto';
import { parsePoint, inServiceArea } from '../domain/geo.js';
import { STOCK_IMAGES } from '../domain/stockImages.js';
import { checkPublicImage } from '../domain/images.js';
import { putObject, deleteObject } from '../storage/objectStore.js';

export class CatalogError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const text = (v, max, field, { required = true } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw new CatalogError(`${field} is required`);
  if (s.length > max) throw new CatalogError(`${field} is too long (max ${max})`);
  return s;
};
const price = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new CatalogError('price must be between $0.01 and $1000');
  return Math.round(n * 100) / 100;
};
const sortOf = (v) => (v === undefined ? undefined : Math.max(0, Math.min(9999, Math.round(Number(v) || 0))));
const bool = (v) => (v === undefined ? undefined : Boolean(v));
// Only the fields given: a PATCH that omits `price` must not reset it.
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function categoryData(body, partial) {
  const pick = (k, fn) => (partial && body[k] === undefined ? undefined : fn(body[k]));
  return defined({
    name_en: pick('name_en', (v) => text(v, 60, 'English name')),
    name_so: pick('name_so', (v) => text(v, 60, 'Somali name')),
    icon: pick('icon', (v) => text(v ?? '', 8, 'icon', { required: false })),
    service: pick('service', (v) => {
      const val = v ?? 'shop';
      if (!['food', 'grocery', 'pharmacy', 'water', 'shop'].includes(val)) throw new CatalogError('service is food, grocery, pharmacy, water or shop');
      return val;
    }),
    sort: sortOf(body.sort),
    active: bool(body.active),
  });
}

// An item's picture: a bundled stock file by name, or none. An uploaded object only comes in
// through its own route (setItemImage) or a published suggestion — never typed into a form.
function imageOf(v, { allowObjectImage = false } = {}) {
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new CatalogError('choose a picture from the list');
  if (v.startsWith('stock/') && STOCK_IMAGES.includes(v.slice(6))) return v;
  if (allowObjectImage && /^obj\/[A-Za-z0-9._/-]{1,120}$/.test(v)) return v;
  throw new CatalogError('choose a picture from the list');
}

function tradeData(body, partial) {
  const pick = (k, fn) => (partial && body[k] === undefined ? undefined : fn(body[k]));
  return defined({
    slug: partial ? undefined : pick('slug', (v) => {
      if (typeof v !== 'string' || !/^[a-z][a-z0-9_]{1,30}$/.test(v)) throw new CatalogError('the code is lowercase letters, like "plumber"');
      return v;
    }),
    name_en: pick('name_en', (v) => text(v, 60, 'English name')),
    name_so: pick('name_so', (v) => text(v, 60, 'Somali name')),
    icon: pick('icon', (v) => text(v ?? '', 8, 'icon', { required: false })),
    visit_fee: pick('visit_fee', price),
    sort: sortOf(body.sort),
    active: bool(body.active),
  });
}

function itemData(body, partial, opts = {}) {
  const pick = (k, fn) => (partial && body[k] === undefined ? undefined : fn(body[k]));
  return defined({
    category_id: pick('category_id', (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new CatalogError('choose a category');
      return n;
    }),
    name_en: pick('name_en', (v) => text(v, 80, 'English name')),
    name_so: pick('name_so', (v) => text(v, 80, 'Somali name')),
    unit_en: pick('unit_en', (v) => text(v ?? '', 30, 'unit', { required: false })),
    unit_so: pick('unit_so', (v) => text(v ?? '', 30, 'Somali unit', { required: false })),
    price: pick('price', price),
    description_en: pick('description_en', (v) => text(v ?? '', 160, 'description', { required: false })),
    description_so: pick('description_so', (v) => text(v ?? '', 160, 'Somali description', { required: false })),
    image: body.image === undefined ? undefined : imageOf(body.image, opts),
    sort: sortOf(body.sort),
    active: bool(body.active),
  });
}

function placeData(body, partial) {
  const pick = (k, fn) => (partial && body[k] === undefined ? undefined : fn(body[k]));
  const out = defined({
    kind: pick('kind', (v) => {
      if (!['market', 'landmark', 'district'].includes(v)) throw new CatalogError('kind is market, landmark or district');
      return v;
    }),
    name_en: pick('name_en', (v) => text(v, 80, 'English name')),
    name_so: pick('name_so', (v) => text(v, 80, 'Somali name')),
    city: pick('city', (v) => text(v, 40, 'city')),
    sort: sortOf(body.sort),
    active: bool(body.active),
  });
  if (!partial || body.lat !== undefined || body.lng !== undefined) {
    const p = parsePoint({ lat: body.lat, lng: body.lng });
    if (!p || !inServiceArea(p)) throw new CatalogError('the position must be in Somalia');
    out.lat = p.lat;
    out.lng = p.lng;
  }
  return out;
}

const KINDS = {
  category: { model: 'catalogCategory', data: categoryData },
  item: { model: 'catalogItem', data: itemData },
  place: { model: 'place', data: placeData },
  trade: { model: 'trade', data: tradeData },
};

export async function createEntry(kind, body, actor, opts = {}) {
  const k = KINDS[kind];
  const data = k.data(body || {}, false, opts);
  if (kind === 'trade' && await prisma.trade.findUnique({ where: { slug: data.slug } })) {
    throw new CatalogError('that code is already used', 409);
  }
  if (kind === 'item') {
    const cat = await prisma.catalogCategory.findUnique({ where: { id: data.category_id } });
    if (!cat) throw new CatalogError('no such category');
  }
  const row = await prisma[k.model].create({ data });
  await audit({ actor, action: `catalog.${kind}.created`, subject: `${kind}:${row.id}`, detail: data });
  return row;
}

// Nothing is deleted: an order stores the name and price it was bought at, and hiding
// (`active: false`) keeps the history readable.
export async function updateEntry(kind, id, body, actor) {
  const k = KINDS[kind];
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new CatalogError('not found', 404);
  const data = k.data(body || {}, true);
  if (!Object.keys(data).length) throw new CatalogError('nothing to change');
  const before = await prisma[k.model].findUnique({ where: { id: n } });
  if (!before) throw new CatalogError('not found', 404);
  if (data.category_id) {
    const cat = await prisma.catalogCategory.findUnique({ where: { id: data.category_id } });
    if (!cat) throw new CatalogError('no such category');
  }
  const row = await prisma[k.model].update({
    where: { id: n },
    data: kind === 'item' ? { ...data, updated_at: new Date() } : data,
  });
  const changed = Object.fromEntries(Object.keys(data).map((f) => [f, { from: String(before[f]), to: String(row[f]) }]));
  await audit({ actor, action: `catalog.${kind}.updated`, subject: `${kind}:${n}`, detail: changed });
  return row;
}

// Admin uploads an item's own picture. Type from the bytes; a random key, so a replaced
// picture is a new URL and phones don't keep showing the old one.
export async function setItemImage({ id, bytes, actor }) {
  const kind = checkPublicImage(bytes);
  if (kind.error) throw new CatalogError(kind.error);
  const item = await prisma.catalogItem.findUnique({ where: { id: Number(id) || 0 } });
  if (!item) throw new CatalogError('not found', 404);
  const key = `catalog/items/${item.id}/${randomBytes(6).toString('hex')}.${kind.ext}`;
  await putObject(key, bytes, kind.type);
  const row = await prisma.catalogItem.update({ where: { id: item.id }, data: { image: `obj/${key}`, updated_at: new Date() } });
  // The old upload goes; a stock picture or a published suggestion's photo is not ours to delete here.
  if (item.image?.startsWith('obj/catalog/items/')) {
    deleteObject(item.image.slice(4)).catch((err) => console.warn(`[catalog] old image ${item.id}: ${err.message}`));
  }
  await audit({ actor, action: 'catalog.item.image', subject: `item:${item.id}`, detail: { from: item.image, to: row.image } });
  return row;
}
