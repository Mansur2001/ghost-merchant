// The catalog and places a fresh install starts with, so the customer app has something to
// order from on day one. Inserted only into EMPTY tables (at boot, and by the seed after its
// truncate): once an admin has edited the catalog, this never touches it again.
//
// ⚠️ Starter values. Prices are placeholders and the place pins are approximate — an admin who
// knows Mogadishu checks every pin (Operator → Catalog → Places) and every price before launch.

export const STARTER_CATEGORIES = [
  {
    name_en: 'Meals', name_so: 'Cunto', icon: '🍛',
    items: [
      ['Rice with goat meat', 'Bariis iyo hilib ari', 'plate', 'saxan', '4.00'],
      ['Rice with chicken', 'Bariis iyo digaag', 'plate', 'saxan', '4.00'],
      ['Pasta with meat', 'Baasto iyo hilib', 'plate', 'saxan', '3.50'],
      ['Canjeero with suqaar', 'Canjeero iyo suqaar', 'plate', 'saxan', '2.50'],
      ['Sambuusa', 'Sambuusa', '5 pieces', '5 xabbo', '1.50'],
      ['Malawax', 'Malawax', '3 pieces', '3 xabbo', '1.50'],
    ],
  },
  {
    name_en: 'Groceries', name_so: 'Raashin', icon: '🛒',
    items: [
      ['Rice', 'Bariis', '5 kg', '5 kg', '5.00'],
      ['Sugar', 'Sonkor', '2 kg', '2 kg', '2.20'],
      ['Cooking oil', 'Saliid', '3 L', '3 litir', '4.50'],
      ['Flour', 'Bur', '2 kg', '2 kg', '1.80'],
      ['Milk', 'Caano', '1 L', '1 litir', '1.20'],
      ['Eggs', 'Ukun', '12', '12 xabbo', '2.00'],
      ['Tomatoes', 'Yaanyo', '1 kg', '1 kg', '1.00'],
      ['Onions', 'Basal', '1 kg', '1 kg', '0.80'],
      ['Bananas', 'Moos', '1 kg', '1 kg', '0.80'],
    ],
  },
  {
    name_en: 'Drinks', name_so: 'Cabitaan', icon: '🥤',
    items: [
      ['Water', 'Biyo', '6 × 1.5 L', '6 × 1.5 litir', '2.50'],
      ['Soft drink', 'Cabitaan qabow', '1.5 L', '1.5 litir', '1.50'],
      ['Juice', 'Casiir', '1 L', '1 litir', '1.80'],
      ['Tea leaves', 'Shaah', '250 g', '250 g', '1.00'],
    ],
  },
  {
    name_en: 'Household', name_so: 'Alaabta guriga', icon: '🧴',
    items: [
      ['Soap', 'Saabuun', '3 bars', '3 xabbo', '1.20'],
      ['Diapers', 'Xafaayad', 'pack', 'baakad', '6.00'],
      ['Charcoal', 'Dhuxul', '10 kg', '10 kg', '4.00'],
      ['Tissues', 'Tishu', '4 rolls', '4 xabbo', '1.50'],
    ],
  },
];

// [kind, name_en, name_so, lat, lng]. Mogadishu only, to start.
export const STARTER_PLACES = [
  ['market', 'Bakaara Market', 'Suuqa Bakaaraha', 2.0469, 45.3182],
  ['market', 'Hamar Weyne Market', 'Suuqa Xamar Weyne', 2.0336, 45.3420],
  ['landmark', 'KM4 junction', 'Zoobe KM4', 2.0295, 45.3045],
  ['landmark', 'Aden Adde Airport', 'Garoonka Aadan Cadde', 2.0144, 45.3047],
  ['landmark', 'Lido Beach', 'Xeebta Liido', 2.0570, 45.3625],
  ['landmark', 'Mogadishu Stadium', 'Garoonka Muqdisho', 2.0480, 45.3288],
  ['district', 'Hodan', 'Hodan', 2.0320, 45.3100],
  ['district', 'Wadajir', 'Wadajir', 2.0150, 45.2950],
  ['district', 'Karaan', 'Kaaraan', 2.0700, 45.3500],
];

// Fill whichever of the two lists is empty. `db` is a Prisma client or transaction.
export async function ensureStarterCatalog(db) {
  const [categories, places] = await Promise.all([db.catalogCategory.count(), db.place.count()]);
  let added = 0;
  if (categories === 0) {
    for (const [ci, c] of STARTER_CATEGORIES.entries()) {
      // eslint-disable-next-line no-await-in-loop
      await db.catalogCategory.create({
        data: {
          name_en: c.name_en, name_so: c.name_so, icon: c.icon, sort: ci,
          items: {
            create: c.items.map(([name_en, name_so, unit_en, unit_so, price], i) => ({
              name_en, name_so, unit_en, unit_so, price, sort: i,
            })),
          },
        },
      });
      added += 1;
    }
  }
  if (places === 0) {
    await db.place.createMany({
      data: STARTER_PLACES.map(([kind, name_en, name_so, lat, lng], i) => ({
        kind, name_en, name_so, city: 'Mogadishu', lat, lng, sort: i,
      })),
    });
    added += 1;
  }
  return added;
}
