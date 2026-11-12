// Read side for the generic catalog and the fixed places. Public data — the same for every
// customer — so it is small, cacheable and carries nothing about anyone.
import { prisma } from '../db/prisma.js';

const ITEM_FIELDS = {
  id: true, category_id: true, name_en: true, name_so: true, unit_en: true, unit_so: true, price: true, sort: true,
  image: true, description_en: true, description_so: true,
};

// Where the app loads an item's picture from. Stock pictures are static files next to the
// apps; an approved upload is streamed by the backend (GET /api/catalog/items/:id/image), with
// the key's tail as a cache-buster so a replaced picture is fetched again.
export function imageUrl(item) {
  const img = item?.image;
  if (!img) return null;
  if (img.startsWith('stock/')) return `/shared/img/catalog/${img.slice(6)}`;
  if (img.startsWith('obj/')) return `/api/catalog/items/${item.id}/image?v=${encodeURIComponent(img.slice(-12))}`;
  return null;
}
const shapeItem = (i) => ({ ...i, image_url: imageUrl(i) });

export async function getCatalog({ includeInactive = false } = {}) {
  const where = includeInactive ? {} : { active: true };
  const categories = await prisma.catalogCategory.findMany({
    where,
    orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    include: {
      items: {
        where,
        orderBy: [{ sort: 'asc' }, { id: 'asc' }],
        select: includeInactive ? { ...ITEM_FIELDS, active: true } : ITEM_FIELDS,
      },
    },
  });
  return categories
    .filter((c) => includeInactive || c.items.length > 0)
    .map((c) => ({ ...c, items: c.items.map(shapeItem) }));
}

// Farsamo trades with their visit fee.
export async function getTrades({ includeInactive = false } = {}) {
  return prisma.trade.findMany({
    where: includeInactive ? {} : { active: true },
    orderBy: [{ sort: 'asc' }, { id: 'asc' }],
  });
}

export async function getTrade(slug) {
  if (typeof slug !== 'string' || !/^[a-z][a-z0-9_]{1,30}$/.test(slug)) return null;
  return prisma.trade.findFirst({ where: { slug, active: true } });
}

// Active items by id, for pricing a cart (domain/pricing.js priceCart). Only the ids asked for.
export async function getActiveItems(ids) {
  const clean = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 100);
  if (!clean.length) return new Map();
  const rows = await prisma.catalogItem.findMany({
    where: { id: { in: clean }, active: true, category: { active: true } },
    select: ITEM_FIELDS,
  });
  return new Map(rows.map((r) => [r.id, r]));
}

export async function getPlaces({ includeInactive = false, kind } = {}) {
  return prisma.place.findMany({
    where: { ...(includeInactive ? {} : { active: true }), ...(kind ? { kind } : {}) },
    orderBy: [{ city: 'asc' }, { sort: 'asc' }, { name_en: 'asc' }],
    select: { id: true, kind: true, name_en: true, name_so: true, city: true, lat: true, lng: true, ...(includeInactive ? { active: true, sort: true } : {}) },
  });
}

export async function getPlace(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return prisma.place.findFirst({ where: { id: n, active: true } });
}
