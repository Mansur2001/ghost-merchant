// The catalog, trades and places a fresh install starts with, so the customer app has
// something real to order from on day one — every home tile (Cunto, Raashin, Farmashiye,
// Biyo, Farsamo) filled, every item with a licence-free stock picture
// (frontend/shared/img/catalog, sources in its LICENSES.txt).
//
// Inserted into EMPTY tables (at boot, and by the seed after its truncate). An install that
// already has a catalog gets the one-time ADDITIVE upgrade below instead (upgradeStarter):
// categories it doesn't have yet, pictures for items that have none, trades, and places in
// cities it has none in. It never changes a price, a name or anything an admin set.
//
// ⚠️ Starter values. Prices are placeholders and the place pins are approximate — an admin who
// knows each city checks every pin (Operator → Catalog → Places) and every price before launch.
// Pharmacy items are over-the-counter only: nothing that needs a prescription.

import { STOCK_IMAGES } from '../domain/stockImages.js';

// [name_en, name_so, unit_en, unit_so, price, picture]
export const STARTER_CATEGORIES = [
  {
    name_en: 'Meals', name_so: 'Cunto', icon: '🍛', service: 'food',
    items: [
      ['Rice with goat meat', 'Bariis iyo hilib ari', 'plate', 'saxan', '4.00', 'rice-goat'],
      ['Rice with chicken', 'Bariis iyo digaag', 'plate', 'saxan', '4.00', 'rice-chicken'],
      ['Rice with fish', 'Bariis iyo kalluun', 'plate', 'saxan', '4.50', 'fish-rice'],
      ['Pasta with meat', 'Baasto iyo hilib', 'plate', 'saxan', '3.50', 'pasta-meat'],
      ['Canjeero with suqaar', 'Canjeero iyo suqaar', 'plate', 'saxan', '2.50', 'canjeero'],
      ['Grilled chicken', 'Digaag la dubay', 'half', 'badh', '5.00', 'grilled-chicken'],
      ['Sambuusa', 'Sambuusa', '5 pieces', '5 xabbo', '1.50', 'sambuusa'],
      ['Malawax', 'Malawax', '3 pieces', '3 xabbo', '1.50', 'malawax'],
    ],
  },
  {
    name_en: 'Fast food', name_so: 'Cunto degdeg ah', icon: '🍔', service: 'food',
    items: [
      ['Burger', 'Burger', '1', '1 xabbo', '3.50', 'burger'],
      ['Pizza', 'Piisa', 'medium', 'dhexdhexaad', '7.00', 'pizza'],
      ['Chicken and fries', 'Digaag iyo baradho', 'box', 'sanduuq', '4.50', 'chicken-fries'],
      ['Shawarma', 'Shawarma', '1', '1 xabbo', '2.50', 'shawarma'],
      ['Fries', 'Baradho shiilan', 'portion', 'saxan', '1.50', 'fries'],
    ],
  },
  {
    name_en: 'Bakery and sweets', name_so: 'Rooti iyo macmacaan', icon: '🥐', service: 'food',
    items: [
      ['Bread', 'Rooti', 'loaf', 'xabbo', '0.80', 'bread'],
      ['Cake', 'Doolsho', 'slice', 'gabal', '1.50', 'cake'],
      ['Doughnuts', 'Kac kac', '6 pieces', '6 xabbo', '1.20', 'doughnut'],
      ['Halwa', 'Xalwo', '500 g', '500 g', '3.00', 'halwa'],
    ],
  },
  {
    name_en: 'Drinks', name_so: 'Cabitaan', icon: '🥤', service: 'food',
    items: [
      ['Somali tea', 'Shaah', 'flask', 'termuus', '1.50', 'tea'],
      ['Coffee', 'Bun', 'cup', 'koob', '1.00', 'coffee'],
      ['Mango juice', 'Casiir cambe', '1 L', '1 litir', '2.00', 'mango-juice'],
      ['Orange juice', 'Casiir liin', '1 L', '1 litir', '2.00', 'orange-juice'],
      ['Soft drink', 'Cabitaan qabow', '1.5 L', '1.5 litir', '1.50', 'soft-drink'],
    ],
  },
  {
    name_en: 'Staples', name_so: 'Raashinka aasaasiga ah', icon: '🌾', service: 'grocery',
    items: [
      ['Rice', 'Bariis', '5 kg', '5 kg', '5.00', 'rice-bag'],
      ['Sugar', 'Sonkor', '2 kg', '2 kg', '2.20', 'sugar'],
      ['Flour', 'Bur', '2 kg', '2 kg', '1.80', 'flour'],
      ['Pasta', 'Baasto', '500 g', '500 g', '0.90', 'pasta'],
      ['Red lentils', 'Misir', '1 kg', '1 kg', '1.60', 'lentils'],
      ['Beans', 'Digir', '1 kg', '1 kg', '1.50', 'beans'],
      ['Cooking oil', 'Saliid', '3 L', '3 litir', '4.50', 'cooking-oil'],
      ['Salt', 'Cusbo', '1 kg', '1 kg', '0.50', 'salt'],
      ['Dates', 'Timir', '1 kg', '1 kg', '3.00', 'dates'],
      ['Tea leaves', 'Caleen shaah', '250 g', '250 g', '1.00', 'tea-leaves'],
      ['Coffee beans', 'Bun la shiidi', '250 g', '250 g', '2.50', 'coffee-beans'],
    ],
  },
  {
    name_en: 'Fruit and vegetables', name_so: 'Khudaar iyo miro', icon: '🥬', service: 'grocery',
    items: [
      ['Tomatoes', 'Yaanyo', '1 kg', '1 kg', '1.00', 'tomatoes'],
      ['Onions', 'Basal', '1 kg', '1 kg', '0.80', 'onions'],
      ['Potatoes', 'Baradho', '1 kg', '1 kg', '0.90', 'potatoes'],
      ['Carrots', 'Karooto', '1 kg', '1 kg', '0.90', 'carrots'],
      ['Garlic', 'Toon', '250 g', '250 g', '0.70', 'garlic'],
      ['Lemons', 'Liin dhanaan', '1 kg', '1 kg', '1.00', 'lemons'],
      ['Bananas', 'Moos', '1 kg', '1 kg', '0.80', 'bananas'],
      ['Mangoes', 'Cambe', '1 kg', '1 kg', '1.20', 'mangoes'],
      ['Watermelon', 'Qare', '1', '1 xabbo', '2.50', 'watermelon'],
    ],
  },
  {
    name_en: 'Milk and eggs', name_so: 'Caano iyo ukun', icon: '🥛', service: 'grocery',
    items: [
      ['Milk', 'Caano', '1 L', '1 litir', '1.20', 'milk'],
      ['Camel milk', 'Caano geel', '1 L', '1 litir', '1.50', 'camel-milk'],
      ['Eggs', 'Ukun', '12', '12 xabbo', '2.00', 'eggs'],
      ['Ghee', 'Subag', '500 g', '500 g', '4.00', 'ghee'],
      ['Yogurt', 'Caano fadhi', '1 L', '1 litir', '1.50', 'yogurt'],
    ],
  },
  {
    name_en: 'Meat and fish', name_so: 'Hilib iyo kalluun', icon: '🥩', service: 'grocery',
    items: [
      ['Goat meat', 'Hilib ari', '1 kg', '1 kg', '7.00', 'goat-meat'],
      ['Beef', 'Hilib lo\'aad', '1 kg', '1 kg', '6.00', 'beef'],
      ['Chicken', 'Digaag', 'whole', 'dhan', '6.50', 'chicken'],
      ['Fish', 'Kalluun', '1 kg', '1 kg', '5.00', 'fish'],
    ],
  },
  {
    name_en: 'Household', name_so: 'Alaabta guriga', icon: '🧴', service: 'shop',
    items: [
      ['Soap', 'Saabuun', '3 bars', '3 xabbo', '1.20', 'soap'],
      ['Washing powder', 'Oomo', '1 kg', '1 kg', '2.50', 'detergent'],
      ['Dish soap', 'Saabuun weelka', '750 ml', '750 ml', '1.50', 'dish-soap'],
      ['Tissues', 'Tishu', '4 rolls', '4 xabbo', '1.50', 'toilet-paper'],
      ['Charcoal', 'Dhuxul', '10 kg', '10 kg', '4.00', null],
    ],
  },
  {
    name_en: 'Medicine (no prescription)', name_so: 'Daawo (warqad la\'aan)', icon: '💊', service: 'pharmacy',
    items: [
      ['Paracetamol 500 mg', 'Baarasitamool 500 mg', '20 tablets', '20 kiniin', '1.00', 'paracetamol'],
      ['Ibuprofen 200 mg', 'Ibubrofeen 200 mg', '20 tablets', '20 kiniin', '1.50', 'ibuprofen'],
      ['Rehydration salts (ORS)', 'Milix (ORS)', '5 sachets', '5 baakad', '1.00', 'ors'],
      ['Vitamin C', 'Fiitamiin C', '30 tablets', '30 kiniin', '2.50', 'vitamins'],
      ['Mosquito repellent', 'Daawada kaneecada', '1', '1 xabbo', '3.00', 'repellent'],
    ],
  },
  {
    name_en: 'First aid', name_so: 'Gargaarka degdegga', icon: '🩹', service: 'pharmacy',
    items: [
      ['Plasters', 'Balastar', '20', '20 xabbo', '1.00', 'plasters'],
      ['Bandage', 'Faashad', '1 roll', '1 duub', '1.00', 'bandage'],
      ['Antiseptic', 'Daawada nadiifinta nabarka', '250 ml', '250 ml', '2.50', 'antiseptic'],
      ['Thermometer', 'Kulbeeg', '1', '1 xabbo', '4.00', 'thermometer'],
      ['Hand sanitizer', 'Nadiifiyaha gacmaha', '250 ml', '250 ml', '2.00', 'sanitizer'],
      ['Face masks', 'Af-xir', '10', '10 xabbo', '1.50', 'masks'],
    ],
  },
  {
    name_en: 'Baby and personal care', name_so: 'Ilmaha iyo nadaafadda', icon: '🧼', service: 'pharmacy',
    items: [
      ['Diapers', 'Xafaayad', 'pack', 'baakad', '6.00', 'diapers'],
      ['Sanitary pads', 'Suufka haweenka', 'pack', 'baakad', '1.50', 'pads'],
      ['Toothpaste', 'Daawada ilkaha', '1', '1 xabbo', '1.20', 'toothpaste'],
      ['Toothbrush', 'Cadayga', '1', '1 xabbo', '0.80', 'toothbrush'],
    ],
  },
  {
    name_en: 'Water', name_so: 'Biyo', icon: '💧', service: 'water',
    items: [
      ['Water bottles', 'Biyo dhalo', '6 × 1.5 L', '6 × 1.5 litir', '2.50', 'water-6pack'],
      ['Small water bottles', 'Biyo dhalo yar', '12 × 0.5 L', '12 × 0.5 litir', '3.00', 'water-small'],
      ['Jerrycan refill', 'Gaalan biyo', '20 L', '20 litir', '1.50', 'water-20l'],
      ['Dispenser bottle', 'Dhalada biyaha qaboojiyaha', '20 L', '20 litir', '3.00', 'water-dispenser'],
      ['Ice', 'Baraf', '2 kg bag', 'kiish 2 kg', '1.00', 'ice'],
      ['Water truck', 'Boosar biyo', '1,000 L', '1,000 litir', '15.00', 'water-truck'],
    ],
  },
];

// Farsamo: [slug, name_en, name_so, icon, visit fee]. The fee pays for the visit and a look;
// more work is quoted in the app by the technician (commands/extraWork.js).
export const STARTER_TRADES = [
  ['plumber', 'Plumber', 'Tuubbiste', '🚰', '5.00'],
  ['electrician', 'Electrician', 'Korontoyaqaan', '💡', '5.00'],
  ['ac', 'AC and fridge repair', 'Dayactirka qaboojiyaha', '❄️', '7.00'],
  ['carpenter', 'Carpenter', 'Nijaar', '🪚', '5.00'],
  ['painter', 'Painter', 'Rinjiile', '🎨', '6.00'],
  ['phone', 'Phone repair', 'Dayactirka taleefanka', '📱', '3.00'],
  ['mechanic', 'Mechanic', 'Makaanik', '🔧', '6.00'],
  ['cleaner', 'House cleaning', 'Nadiifinta guriga', '🧹', '8.00'],
];

// [city, kind, name_en, name_so, lat, lng]. Every city has a market: a delivery is bought at
// the nearest one, and one in another city is too far to quote.
export const STARTER_PLACES = [
  ['Mogadishu', 'market', 'Bakaara Market', 'Suuqa Bakaaraha', 2.0469, 45.3182],
  ['Mogadishu', 'market', 'Hamar Weyne Market', 'Suuqa Xamar Weyne', 2.0336, 45.3420],
  ['Mogadishu', 'landmark', 'KM4 junction', 'Zoobe KM4', 2.0295, 45.3045],
  ['Mogadishu', 'landmark', 'Aden Adde Airport', 'Garoonka Aadan Cadde', 2.0144, 45.3047],
  ['Mogadishu', 'landmark', 'Lido Beach', 'Xeebta Liido', 2.0570, 45.3625],
  ['Mogadishu', 'landmark', 'Mogadishu Stadium', 'Garoonka Muqdisho', 2.0480, 45.3288],
  ['Mogadishu', 'district', 'Hodan', 'Hodan', 2.0320, 45.3100],
  ['Mogadishu', 'district', 'Wadajir', 'Wadajir', 2.0150, 45.2950],
  ['Mogadishu', 'district', 'Karaan', 'Kaaraan', 2.0700, 45.3500],
  ['Boosaaso', 'market', 'Boosaaso Main Market', 'Suuqa Weyn ee Boosaaso', 11.2847, 49.1828],
  ['Boosaaso', 'landmark', 'Boosaaso Port', 'Dekedda Boosaaso', 11.2880, 49.1890],
  ['Boosaaso', 'landmark', 'Bender Qassim Airport', 'Garoonka Bender Qaasim', 11.2756, 49.1494],
  ['Boosaaso', 'landmark', 'Boosaaso Stadium', 'Garoonka Kubadda Boosaaso', 11.2790, 49.1765],
  ['Boosaaso', 'district', 'Raf Raf', 'Raf Raf', 11.2700, 49.1700],
  ['Hargeisa', 'market', 'Waaheen Market', 'Suuqa Waaheen', 9.5609, 44.0647],
  ['Hargeisa', 'landmark', 'Egal Airport', 'Garoonka Cigaal', 9.5182, 44.0888],
  ['Garowe', 'market', 'Garowe Market', 'Suuqa Garoowe', 8.4054, 48.4845],
  ['Kismaayo', 'market', 'Kismaayo Market', 'Suuqa Kismaayo', -0.3582, 42.5454],
  ['Baidoa', 'market', 'Baidoa Market', 'Suuqa Baydhabo', 3.1137, 43.6498],
  ['Beledweyne', 'market', 'Beledweyne Market', 'Suuqa Beledweyne', 4.7358, 45.2036],
  ['Galkayo', 'market', 'Galkayo Market', 'Suuqa Gaalkacyo', 6.7697, 47.4308],
];

// Only a picture that is really bundled: an item without one shows its category icon.
const stock = (slug) => (slug && STOCK_IMAGES.includes(`${slug}.jpg`) ? `stock/${slug}.jpg` : null);
const itemRow = ([name_en, name_so, unit_en, unit_so, price, pic], i) => ({
  name_en, name_so, unit_en, unit_so, price, sort: i, image: stock(pic),
});

async function addCategory(db, c, sort) {
  await db.catalogCategory.create({
    data: {
      name_en: c.name_en, name_so: c.name_so, icon: c.icon, service: c.service, sort,
      items: { create: c.items.map(itemRow) },
    },
  });
}

// Fill whichever lists are empty. `db` is a Prisma client or transaction.
export async function ensureStarterCatalog(db) {
  const [categories, places, trades] = await Promise.all([db.catalogCategory.count(), db.place.count(), db.trade.count()]);
  let added = 0;
  if (categories === 0) {
    for (const [ci, c] of STARTER_CATEGORIES.entries()) {
      // eslint-disable-next-line no-await-in-loop
      await addCategory(db, c, ci);
    }
    added += 1;
  }
  if (places === 0) {
    await db.place.createMany({
      data: STARTER_PLACES.map(([city, kind, name_en, name_so, lat, lng], i) => ({ kind, name_en, name_so, city, lat, lng, sort: i })),
    });
    added += 1;
  }
  if (trades === 0) {
    await db.trade.createMany({
      data: STARTER_TRADES.map(([slug, name_en, name_so, icon, visit_fee], i) => ({ slug, name_en, name_so, icon, visit_fee, sort: i })),
    });
    added += 1;
  }
  return added + await upgradeStarter(db);
}

// One time per version, for an install that was already running: ADD what the starter has and
// it doesn't. Matched by English name; a category or item the admin renamed is left alone.
export const STARTER_VERSION = 2;
// The first starter's categories, and which home tile each belongs to.
const LEGACY_SERVICE = { meals: 'food', groceries: 'grocery', drinks: 'food', household: 'shop' };

export async function upgradeStarter(db) {
  const row = await db.appSetting.findUnique({ where: { key: 'starter_version' } });
  if ((row?.value?.v ?? 1) >= STARTER_VERSION) return 0;
  const cats = await db.catalogCategory.findMany({ include: { items: true } });
  const haveItems = new Set(cats.flatMap((c) => c.items.map((i) => i.name_en.toLowerCase())));
  const starterItems = new Map(STARTER_CATEGORIES.flatMap((c) => c.items.map((it) => [it[0].toLowerCase(), it])));
  const serviceOf = new Map([
    ...Object.entries(LEGACY_SERVICE),
    ...STARTER_CATEGORIES.map((c) => [c.name_en.toLowerCase(), c.service]),
  ]);
  // Existing categories: their home tile (if they never had one) and pictures for their items.
  for (const c of cats) {
    const svc = serviceOf.get(c.name_en.toLowerCase());
    // eslint-disable-next-line no-await-in-loop
    if (c.service === 'shop' && svc && svc !== 'shop') await db.catalogCategory.update({ where: { id: c.id }, data: { service: svc } });
    for (const item of c.items) {
      const it = starterItems.get(item.name_en.toLowerCase());
      // eslint-disable-next-line no-await-in-loop
      if (!item.image && it?.[5]) await db.catalogItem.update({ where: { id: item.id }, data: { image: stock(it[5]) } });
    }
  }
  // New categories, with only the items the catalog doesn't already sell somewhere.
  const haveCats = new Set(cats.map((c) => c.name_en.toLowerCase()));
  let sort = cats.length;
  for (const c of STARTER_CATEGORIES) {
    if (haveCats.has(c.name_en.toLowerCase())) continue;
    const items = c.items.filter((it) => !haveItems.has(it[0].toLowerCase()));
    if (!items.length) continue;
    // eslint-disable-next-line no-await-in-loop
    await addCategory(db, { ...c, items }, sort++);
  }
  const cities = new Set((await db.place.findMany({ select: { city: true } })).map((p) => p.city));
  const newPlaces = STARTER_PLACES.filter(([city]) => !cities.has(city));
  if (newPlaces.length) {
    await db.place.createMany({
      data: newPlaces.map(([city, kind, name_en, name_so, lat, lng], i) => ({ kind, name_en, name_so, city, lat, lng, sort: 100 + i })),
    });
  }
  if (await db.trade.count() === 0) {
    await db.trade.createMany({
      data: STARTER_TRADES.map(([slug, name_en, name_so, icon, visit_fee], i) => ({ slug, name_en, name_so, icon, visit_fee, sort: i })),
    });
  }
  await db.appSetting.upsert({
    where: { key: 'starter_version' },
    create: { key: 'starter_version', value: { v: STARTER_VERSION }, updated_by: 'system:starter' },
    update: { value: { v: STARTER_VERSION }, updated_by: 'system:starter', updated_at: new Date() },
  });
  return 1;
}
