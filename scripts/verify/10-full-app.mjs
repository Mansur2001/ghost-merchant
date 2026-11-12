// The full customer app (2026-11-11) over real HTTP, against STAGING: choosing your driver
// (offer, accept, decline, expiry), parcels, Farsamo visits and extra work, ratings, catalog
// suggestions and pictures, the free-delivery promo, USSD wallet top-ups, the inbox, AI
// drafts — and who may see what. Reseeds staging first.
//
//   ./scripts/staging.sh up
//   cp scripts/verify/10-full-app.mjs backend/.verify-tmp.mjs && \
//     (cd backend && NODE_TLS_REJECT_UNAUTHORIZED=0 node .verify-tmp.mjs); rm backend/.verify-tmp.mjs
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(dir, 'docker-compose.yml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not locate the repo root');
}
const ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.GK_BASE || 'https://localhost:8444';
const API = `${BASE}/api`;
const dc = 'docker compose -p gurikaabe-staging --env-file .env.staging -f docker-compose.yml -f docker-compose.staging.yml';
const sh = (cmd, input) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', input }).trim();
const sql = (q) => sh(`${dc} exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA'`, q);

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  if (ok) { console.log(`  PASS  ${label}`); pass += 1; } else { console.log(`  FAIL  ${label} ${detail}`); fail += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(path, { method = 'GET', token, body, raw, type } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': type || 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json || {} };
}
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
  }
}
const JPEG = readFileSync(join(ROOT, 'frontend/shared/img/catalog/tomatoes.jpg'));

console.log('── reseeding staging ──');
sh(`${dc} exec -T redis sh -c 'redis-cli --scan --pattern "rl:*" | xargs -r redis-cli DEL' >/dev/null 2>&1 || true`);
sh(`${dc} exec -T -e SEED_CONFIRM=wipe-local-data backend npm run seed >/dev/null 2>&1`);

async function customer(tag) {
  const email = `full-${tag}-${Date.now()}@example.com`;
  return (await call('/auth/signup', { method: 'POST', body: { email, password: `Sahan-${tag}-route-2026` } })).body.token;
}
const alice = await customer('a');
const bob = await customer('b');
const driver = async (msisdn, pin) => (await call('/driver/login', { method: 'POST', body: { msisdn, pin } })).body.token;
const amina = await driver('+252619876543', '1234');
const bashir = await driver('+252651112223', '5678');
const daahir = await driver('+252615550101', '1357');
const cali = await driver('+252631234567', '2468');
const admin = (await call('/operator/login', { method: 'POST', body: { username: 'admin', password: 'change-me-please-1' } })).body.token;
const hodan = (await call('/operator/login', { method: 'POST', body: { username: 'hodan', password: 'seeded-operator-pw-1' } })).body.token;
chk('customers, drivers, a technician and two operators signed in', Boolean(alice && bob && amina && bashir && daahir && admin && hodan));
let refSeq = 1;
const pay = (id) => call(`/operator/orders/${id}/mark-paid`, { method: 'POST', token: hodan, body: { reference: `FULL${Date.now()}${refSeq++}` } });
const order = async (id, token = admin) => (await call(`/orders/${id}`, { token })).body.order;

console.log('\n── public bits: trades, the banner, pictures ──');
const trades = (await call('/trades')).body.trades || [];
chk('Farsamo trades listed with a visit fee', trades.length >= 5 && trades.every((t) => Number(t.visit_fee) > 0));
chk('free delivery starts off', (await call('/settings/public')).body.freeDelivery?.enabled === false);
const cat = (await call('/catalog')).body.categories || [];
chk('every home tile has a shop', ['food', 'grocery', 'pharmacy', 'water'].every((s) => cat.some((c) => c.service === s)));
const pics = cat.flatMap((c) => c.items).filter((i) => i.image_url);
chk('most items carry a picture', pics.length >= 50, `${pics.length}`);
const stock = await fetch(`${BASE}${pics[0].image_url}`);
chk('a stock picture is served as an image', stock.status === 200 && /image\/jpeg/.test(stock.headers.get('content-type') || ''));

console.log('\n── the greeting, the nearby banner ──');
chk('a new account has no name', (await call('/me', { token: alice })).body.name === null);
chk('a name can be set', (await call('/me/name', { method: 'POST', token: alice, body: { name: '  Hodan   Ali ' } })).body.name === 'Hodan Ali');
const STADIUM = { lat: 2.0480, lng: 45.3288 };
// The seed's paid order is waiting for the next free driver: stop it at the desk, so the drivers
// this suite puts online stay free for its rides.
for (const id of sql("SELECT id FROM orders WHERE status = 'PAID_UNASSIGNED'").split('\n').filter(Boolean)) {
  // eslint-disable-next-line no-await-in-loop
  await call(`/operator/orders/${id}/refund`, { method: 'POST', token: hodan, body: { reason: 'suite setup' } });
}
// Amina carries deliveries (a rider only gets a driver with no job); Bashir switches to a bajaj.
await call(`/operator/drivers/${sql("SELECT id FROM drivers WHERE name='Bashir'")}/vehicle`, { method: 'POST', token: admin, body: { vehicle: 'bajaj' } });
await call('/driver/online', { method: 'POST', token: bashir, body: { online: true } });
await call('/driver/location', { method: 'POST', token: bashir, body: { lat: 2.0484, lng: 45.3290, accuracy: 10 } });
const near = (await call(`/nearby?lat=${STADIUM.lat}&lng=${STADIUM.lng}`, { token: alice })).body.nearby;
chk('nearby: a count and minutes, no positions', near?.bajaj?.count >= 1 && near.bajaj.eta_min >= 1 && !JSON.stringify(near).includes('45.329'));
chk('nearby needs a customer', (await call(`/nearby?lat=2&lng=45`)).status === 401);

console.log('\n── choosing your driver: offer, accept ──');
const AIRPORT = { lat: 2.0144, lng: 45.3047 };
const q = (await call('/quote', { method: 'POST', token: alice, body: { kind: 'RIDE', pickup: STADIUM, dropoff: AIRPORT } })).body.quote;
const bajaj = q?.options.find((o) => o.vehicle === 'bajaj');
const aminaCard = bajaj?.drivers.find((d) => d.name === 'Bashir');
chk('the quote lists drivers to choose from', Boolean(aminaCard));
chk('a driver card: first name, plate, minutes — no phone, no position', aminaCard && aminaCard.plate === 'MOG 4521' && aminaCard.eta_min >= 1
  && !JSON.stringify(bajaj.drivers).match(/\+252|"lat"|"lng"|msisdn/));
const ride1 = randomUUID();
const placed = await call('/orders', { method: 'POST', token: alice, body: { kind: 'RIDE', id: ride1, vehicle: 'bajaj', driverId: aminaCard.id, pickup: STADIUM, dropoff: AIRPORT, phone: '612345678', expectedTotal: bajaj.total } });
chk('booked with a chosen driver', placed.status === 201 && String(placed.body.order.requested_driver_id) === aminaCard.id);
const ghost = await call('/orders', { method: 'POST', token: alice, body: { kind: 'RIDE', id: randomUUID(), vehicle: 'bajaj', driverId: '999999', pickup: STADIUM, dropoff: AIRPORT, phone: '612345678', expectedTotal: bajaj.total } });
chk('a driver who is not on the list is refused with a fresh quote', ghost.status === 409 && Boolean(ghost.body.quote));
await pay(ride1);
const offered = await order(ride1);
chk('paid: offered to the chosen driver, not assigned yet', offered.status === 'PAID_UNASSIGNED' && String(offered.offer_driver_id) === aminaCard.id);
const offers = (await call('/driver/offers', { token: bashir })).body.offers || [];
chk('the chosen driver sees the offer — without the rider\'s phone', offers.some((o) => o.id === ride1) && !JSON.stringify(offers).includes('+252'));
chk('another driver sees nothing', ((await call('/driver/offers', { token: amina })).body.offers || []).length === 0);
chk('another driver can\'t accept it', (await call(`/driver/offers/${ride1}/accept`, { method: 'POST', token: amina, body: {} })).status === 404);
chk('the offered driver still can\'t open the job (not theirs yet)', (await call(`/driver/orders/${ride1}`, { token: bashir })).status === 404);
const card = (await call(`/orders/${ride1}/driver`, { token: alice })).body.driver;
chk('the rider sees "waiting for Amina" with a deadline', card?.offer === true && card.name === 'Bashir' && Boolean(card.offer_expires_at));
chk('an offer carries no phone (not taken yet)', card?.phone === null && !JSON.stringify(card).includes('+252'));
chk('nobody else sees that card', (await call(`/orders/${ride1}/driver`, { token: bob })).status === 404);
const acc = await call(`/driver/offers/${ride1}/accept`, { method: 'POST', token: bashir, body: {} });
const r1 = await order(ride1);
chk('accepted: dispatched to her', acc.status === 200 && r1.status === 'DISPATCHED' && String(r1.driver_id) === aminaCard.id && r1.offer_driver_id === null);
chk('accepting twice is a 404 (the offer is gone)', (await call(`/driver/offers/${ride1}/accept`, { method: 'POST', token: bashir, body: {} })).status === 404);
const card2 = (await call(`/orders/${ride1}/driver`, { token: alice })).body.driver;
const bashirPhone = sql("SELECT msisdn FROM drivers WHERE name = 'Bashir'");
chk('now the card is the driver: plate, and the phone to call while the job is live', card2?.offer === false && card2.plate === 'MOG 4521' && card2.phone === bashirPhone);

console.log('\n── decline, then expiry: the nearest takes it ──');
// Cali finishes her seeded ride first (the rider's code is in the seed), then she is free.
const caliRide = sql("SELECT id FROM orders WHERE kind = 'RIDE' AND status = 'DISPATCHED' AND driver_id = (SELECT id FROM drivers WHERE name='Cali') LIMIT 1");
await call(`/driver/orders/${caliRide}/secured`, { method: 'POST', token: cali, body: { code: sql(`SELECT code FROM delivery_handoffs WHERE order_id = '${caliRide}'`) } });
await call(`/driver/orders/${caliRide}/dropoff`, { method: 'POST', token: cali, body: {} });
await call('/driver/location', { method: 'POST', token: cali, body: { lat: 2.0478, lng: 45.3285, accuracy: 10 } });
const q2 = (await call('/quote', { method: 'POST', token: bob, body: { kind: 'RIDE', pickup: STADIUM, dropoff: AIRPORT } })).body.quote;
const bashirCard = q2.options.find((o) => o.vehicle === 'bajaj').drivers.find((d) => d.name === 'Cali');
chk('a driver on a job is not offered to riders', !q2.options.find((o) => o.vehicle === 'bajaj').drivers.some((d) => d.name === 'Bashir' || d.name === 'Amina'));
const ride2 = randomUUID();
await call('/orders', { method: 'POST', token: bob, body: { kind: 'RIDE', id: ride2, vehicle: 'bajaj', driverId: bashirCard?.id, pickup: STADIUM, dropoff: AIRPORT, phone: '651234567', expectedTotal: q2.options.find((o) => o.vehicle === 'bajaj').total } });
await pay(ride2);
chk('offered to Cali', String((await order(ride2)).offer_driver_id) === bashirCard?.id);
const dec = await call(`/driver/offers/${ride2}/decline`, { method: 'POST', token: cali, body: {} });
const r2 = await order(ride2);
chk('declined: never offered or given to him again; waits for the next free driver', dec.status === 200 && r2.offer_driver_id === null
  && r2.released_by.map(String).includes(bashirCard.id) && r2.status === 'PAID_UNASSIGNED');
const msgs = (await call(`/orders/${ride2}/messages`, { token: bob })).body.messages || [];
chk('the rider is told the nearest is coming', msgs.some((m) => /nearest free driver/.test(m.body)));
// Expiry: a third ride offered to Bashir again would be refused (released) — use a fresh offer
// on a new order and move its deadline into the past; the 5 s sweep takes over.
const ride3 = randomUUID();
const q3 = (await call('/quote', { method: 'POST', token: alice, body: { kind: 'RIDE', pickup: STADIUM, dropoff: AIRPORT } })).body.quote;
const b3 = q3.options.find((o) => o.vehicle === 'bajaj');
await call('/orders', { method: 'POST', token: alice, body: { kind: 'RIDE', id: ride3, vehicle: 'bajaj', driverId: b3.drivers.find((d) => d.name === 'Cali')?.id, pickup: STADIUM, dropoff: AIRPORT, phone: '612345678', expectedTotal: b3.total } });
await pay(ride3);
chk('a new ride can be offered to him', String((await order(ride3)).offer_driver_id) === bashirCard.id);
sql(`UPDATE orders SET offer_expires_at = now() - interval '1 second' WHERE id = '${ride3}'`);
const expired = await waitFor(async () => { const o = await order(ride3); return o.offer_driver_id === null ? o : null; }, 15000);
chk('time ran out: the offer closes by itself, and dispatch moves on', Boolean(expired) && expired.released_by.map(String).includes(bashirCard.id));
chk('audited: offered, declined, expired', Number(sql("SELECT count(*) FROM audit_log WHERE action IN ('order.offered','order.offer_declined','order.offer_expired')")) >= 4);

console.log('\n── a ride finishes; the rider rates it ──');
const code1 = (await call(`/orders/${ride1}/handoff`, { token: alice })).body.code;
await call(`/driver/orders/${ride1}/secured`, { method: 'POST', token: bashir, body: { code: code1 } });
const drop = await call(`/driver/orders/${ride1}/dropoff`, { method: 'POST', token: bashir, body: { fix: { ...AIRPORT, accuracy: 10 } } });
chk('the ride is finished', drop.status === 200 && (await order(ride1)).status === 'DELIVERED');
chk('finished: the card keeps no phone', (await call(`/orders/${ride1}/driver`, { token: alice })).body.driver?.phone === null);
chk('someone else can\'t rate it', (await call(`/orders/${ride1}/rating`, { method: 'POST', token: bob, body: { stars: 1 } })).status === 404);
chk('0 stars is refused', (await call(`/orders/${ride1}/rating`, { method: 'POST', token: alice, body: { stars: 0 } })).status === 400);
chk('rated 5 stars', (await call(`/orders/${ride1}/rating`, { method: 'POST', token: alice, body: { stars: 5, comment: 'Fast' } })).status === 201);
chk('only once', (await call(`/orders/${ride1}/rating`, { method: 'POST', token: alice, body: { stars: 1 } })).status === 409);
chk('an unfinished job can\'t be rated', (await call(`/orders/${ride2}/rating`, { method: 'POST', token: bob, body: { stars: 4 } })).status === 409);
const roster = (await call('/operator/drivers', { token: hodan })).body.drivers || [];
chk('the desk sees his rating', roster.find((d) => d.name === 'Bashir')?.ratings >= 1);

console.log('\n── a parcel ──');
const KM4 = { lat: 2.0295, lng: 45.3045 };
const pq = await call('/quote', { method: 'POST', token: bob, body: { kind: 'PARCEL', pickup: KM4, dropoff: STADIUM } });
chk('a parcel is priced by distance', pq.status === 200 && Number(pq.body.quote.total) >= 1.5 && pq.body.quote.subtotal === '0.00');
const noRecipient = await call('/orders', { method: 'POST', token: bob, body: { kind: 'PARCEL', id: randomUUID(), pickup: KM4, dropoff: STADIUM, details: 'Keys', landmark: 'Gate', phone: '651234567' } });
chk('a parcel needs the receiver\'s phone', noRecipient.status === 400);
const parcelId = randomUUID();
const pp = await call('/orders', { method: 'POST', token: bob, body: { kind: 'PARCEL', id: parcelId, pickup: KM4, dropoff: STADIUM, details: 'House keys in an envelope', recipientPhone: '612223344', landmark: 'Blue gate', phone: '651234567', expectedTotal: pq.body.quote.total } });
chk('a parcel is booked, receiver normalised', pp.status === 201 && pp.body.order.kind === 'PARCEL' && pp.body.order.recipient_phone === '+252612223344');

console.log('\n── a Farsamo visit and extra work ──');
// Daahir is on a seeded visit: finish it (the customer's code is in the seed), so he is free.
const seededVisit = sql("SELECT id FROM orders WHERE kind = 'SERVICE' AND status = 'IN_TRANSIT' LIMIT 1");
const seededCode = sql(`SELECT code FROM delivery_handoffs WHERE order_id = '${seededVisit}'`);
chk('a technician finishes a visit with the customer\'s code', (await call(`/driver/orders/${seededVisit}/delivered`, { method: 'POST', token: daahir, body: { code: seededCode } })).status === 200);
await call('/driver/location', { method: 'POST', token: daahir, body: { lat: 2.0390, lng: 45.3180, accuracy: 15 } });
const sq = await call('/quote', { method: 'POST', token: alice, body: { kind: 'SERVICE', trade: 'plumber', dropoff: { lat: 2.0400, lng: 45.3190 } } });
chk('a visit is priced at the trade\'s fee, with technicians free', sq.status === 200 && sq.body.quote.total === '5.00' && sq.body.quote.available >= 1);
chk('an unknown trade is refused', (await call('/quote', { method: 'POST', token: alice, body: { kind: 'SERVICE', trade: 'astronaut', dropoff: STADIUM } })).status === 400);
const visit = randomUUID();
await call('/orders', { method: 'POST', token: alice, body: { kind: 'SERVICE', id: visit, trade: 'plumber', dropoff: { lat: 2.0400, lng: 45.3190 }, details: 'Shower drain blocked', landmark: 'Yellow door', phone: '612345678', expectedTotal: '5.00' } });
await pay(visit);
const v1 = await order(visit);
chk('paid: dispatched to the technician with that trade', v1.status === 'DISPATCHED' && v1.driver_id === sql("SELECT id FROM drivers WHERE name='Daahir'"));
chk('a driver never gets a visit', v1.driver_id !== sql("SELECT id FROM drivers WHERE name='Bashir'"));
chk('no extra work before the job starts', (await call(`/driver/orders/${visit}/extra`, { method: 'POST', token: daahir, body: { description: 'New pipe', amount: 6 } })).status === 409);
await call(`/driver/orders/${visit}/pickup-proof`, { method: 'POST', token: daahir, raw: JPEG, type: 'image/jpeg' });
const started = await call(`/driver/orders/${visit}/secured`, { method: 'POST', token: daahir, body: { fix: { lat: 2.0401, lng: 45.3191, accuracy: 10 } } });
chk('started with a photo of the problem', started.status === 200 && (await order(visit)).status === 'IN_TRANSIT');
chk('another driver can\'t quote on it', (await call(`/driver/orders/${visit}/extra`, { method: 'POST', token: bashir, body: { description: 'x y z', amount: 6 } })).status === 404);
chk('a silly price is refused', (await call(`/driver/orders/${visit}/extra`, { method: 'POST', token: daahir, body: { description: 'New pipe', amount: 9000 } })).status === 400);
const ex = await call(`/driver/orders/${visit}/extra`, { method: 'POST', token: daahir, body: { description: 'New drain pipe', amount: 6.5 } });
chk('extra work quoted as its own prepaid order', ex.status === 201 && ex.body.order.status === 'PENDING_PAYMENT');
chk('one unpaid quote at a time', (await call(`/driver/orders/${visit}/extra`, { method: 'POST', token: daahir, body: { description: 'Another', amount: 2 } })).status === 409);
const extras = (await call(`/orders/${visit}/extras`, { token: alice })).body.extras || [];
chk('the customer sees it under the visit', extras.length === 1 && Number(extras[0].total_amount) === 6.5);
chk('and nobody else does', (await call(`/orders/${visit}/extras`, { token: bob })).status === 404);
await pay(ex.body.order.id);
const exo = await order(ex.body.order.id);
chk('paid extra work goes straight to that technician', exo.status === 'DISPATCHED' && exo.driver_id === v1.driver_id);

console.log('\n── suggestions: a customer\'s photo becomes a catalog item ──');
const sub = await call('/catalog/submissions', { method: 'POST', token: bob, body: { name: 'Camel meat', note: 'Bakaara, $8/kg', service: 'grocery' } });
chk('a suggestion is made', sub.status === 201);
const subId = sub.body.submission.id;
chk('an SVG pretending to be a photo is refused', (await call(`/catalog/submissions/${subId}/photo`, { method: 'POST', token: bob, raw: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', type: 'image/png' })).status === 400);
chk('someone else can\'t add the photo', (await call(`/catalog/submissions/${subId}/photo`, { method: 'POST', token: alice, raw: JPEG, type: 'image/jpeg' })).status === 404);
chk('the photo is added', (await call(`/catalog/submissions/${subId}/photo`, { method: 'POST', token: bob, raw: JPEG, type: 'image/jpeg' })).status === 201);
const queue = (await call('/operator/submissions', { token: hodan })).body.submissions || [];
chk('operators see it — without the customer\'s contact', queue.some((s) => s.id === subId) && !JSON.stringify(queue).match(/@example|user_id/));
chk('an operator can\'t publish (prices are admins\')', (await call(`/operator/submissions/${subId}/publish`, { method: 'POST', token: hodan, body: {} })).status === 403);
chk('an operator forwards it', (await call(`/operator/submissions/${subId}/review`, { method: 'POST', token: hodan, body: { decision: 'forward' } })).status === 200);
const groceries = cat.find((c) => c.service === 'grocery');
const pub = await call(`/operator/submissions/${subId}/publish`, { method: 'POST', token: admin, body: { category_id: groceries.id, name_en: 'Camel meat', name_so: 'Hilib geel', unit_en: '1 kg', unit_so: '1 kg', price: 8 } });
chk('an admin prices and publishes it', pub.status === 201 && /^obj\//.test(pub.body.item.image));
const live = ((await call('/catalog')).body.categories || []).flatMap((c) => c.items).find((i) => i.id === pub.body.item.id);
const img = await fetch(`${BASE}${live?.image_url}`);
chk('it is in the shop with the customer\'s photo, served to anyone', img.status === 200 && /image\/jpeg/.test(img.headers.get('content-type') || ''));
chk('the customer\'s list says so', ((await call('/catalog/submissions/mine', { token: bob })).body.submissions || [])[0]?.status === 'published');
const sub2 = (await call('/catalog/submissions', { method: 'POST', token: bob, body: { name: 'Snow boots' } })).body.submission;
await call(`/catalog/submissions/${sub2.id}/photo`, { method: 'POST', token: bob, raw: JPEG, type: 'image/jpeg' });
chk('a rejection needs a reason', (await call(`/operator/submissions/${sub2.id}/review`, { method: 'POST', token: hodan, body: { decision: 'reject' } })).status === 400);
await call(`/operator/submissions/${sub2.id}/review`, { method: 'POST', token: hodan, body: { decision: 'reject', note: 'Not sold here' } });
chk('a rejected suggestion loses its photo', sql(`SELECT coalesce(photo_key,'none') FROM catalog_submissions WHERE id = ${sub2.id}`) === 'none');

console.log('\n── stock pictures and uploads by admins ──');
const stockList = (await call('/operator/stock-images', { token: hodan })).body.images || [];
chk('the stock library is listed', stockList.length >= 50);
const anItem = cat[0].items[0];
chk('an admin can give an item a stock picture', (await call(`/operator/catalog/items/${anItem.id}`, { method: 'PATCH', token: admin, body: { image: stockList[3].image } })).status === 200);
chk('but not a made-up path', (await call(`/operator/catalog/items/${anItem.id}`, { method: 'PATCH', token: admin, body: { image: 'obj/orders/someone/delivery_proof.jpg' } })).status === 400);
chk('an operator can\'t change pictures', (await call(`/operator/catalog/items/${anItem.id}/image`, { method: 'POST', token: hodan, raw: JPEG, type: 'image/jpeg' })).status === 403);

console.log('\n── free delivery ──');
chk('an operator can\'t switch it on', (await call('/operator/settings/free_delivery', { method: 'PUT', token: hodan, body: { enabled: true, minSubtotal: 0 } })).status === 403);
chk('an admin switches it on over $10', (await call('/operator/settings/free_delivery', { method: 'PUT', token: admin, body: { enabled: true, minSubtotal: 10 } })).status === 200);
await sleep(11000); // settings are cached 10 s per instance
const rice = cat.flatMap((c) => c.items).find((i) => i.name_en === 'Rice');
const cheap = (await call('/quote', { method: 'POST', token: alice, body: { kind: 'DELIVERY', cart: { lines: [{ itemId: rice.id, qty: 1 }] }, dropoff: STADIUM } })).body.quote;
const big = (await call('/quote', { method: 'POST', token: alice, body: { kind: 'DELIVERY', cart: { lines: [{ itemId: rice.id, qty: 3 }] }, dropoff: STADIUM } })).body.quote;
chk('under the minimum: the fee is charged', cheap.fee !== '0.00' && !cheap.promo);
chk('over it: no fee, the old one shown', big.fee === '0.00' && big.promo === 'free_delivery' && Number(big.fee_before) > 0 && big.total === big.subtotal);
const freeOrder = await call('/orders', { method: 'POST', token: alice, body: { kind: 'DELIVERY', id: randomUUID(), cart: { lines: [{ itemId: rice.id, qty: 3 }] }, dropoff: STADIUM, landmark: 'Gate', phone: '612345678', expectedTotal: big.total } });
chk('the order records the promo', freeOrder.status === 201 && freeOrder.body.order.promo === 'free_delivery');
const rideQ = (await call('/quote', { method: 'POST', token: alice, body: { kind: 'RIDE', pickup: STADIUM, dropoff: AIRPORT } })).body.quote;
chk('never a ride fare', Number(rideQ.options[0].total) > 0);
await call('/operator/settings/free_delivery', { method: 'PUT', token: admin, body: { enabled: false, minSubtotal: 0 } });

console.log('\n── wallet top-up over USSD, confirmed at the desk ──');
const w0 = (await call('/wallet', { token: alice })).body.wallet;
chk('the wallet is on, with USSD top-ups', w0?.enabled === true && w0.ussd === true);
const dial = (await call('/wallet/topup-options?amount=10', { token: alice })).body.ussd || [];
chk('dial links carry %23, never a bare #', dial.length > 0 && dial.every((d) => d.ussdUri.includes('%23') && !d.ussdUri.includes('#')));
const ref = `TOPUP${Date.now()}`;
const claim = await call('/wallet/topup-claim', { method: 'POST', token: alice, body: { amount: 10, wallet: dial[0].id, reference: ref } });
chk('a claim credits nothing by itself', claim.status === 201 && (await call('/wallet', { token: alice })).body.wallet.balance === '0.00');
chk('one claim at a time', (await call('/wallet/topup-claim', { method: 'POST', token: alice, body: { amount: 5, wallet: dial[0].id, reference: `X${ref}` } })).status === 409);
chk('confirming needs the merchant phone\'s reference', (await call(`/operator/topups/${claim.body.attempt.id}/confirm`, { method: 'POST', token: hodan, body: {} })).status === 400);
const conf = await call(`/operator/topups/${claim.body.attempt.id}/confirm`, { method: 'POST', token: hodan, body: { reference: ref } });
chk('confirmed: the balance is $10.00', conf.status === 200 && (await call('/wallet', { token: alice })).body.wallet.balance === '10.00');
chk('confirming twice is refused', (await call(`/operator/topups/${claim.body.attempt.id}/confirm`, { method: 'POST', token: hodan, body: { reference: ref } })).status === 409);
const claim2 = await call('/wallet/topup-claim', { method: 'POST', token: bob, body: { amount: 5, wallet: dial[0].id, reference: ref } });
chk('one telecom reference can\'t credit two wallets', (await call(`/operator/topups/${claim2.body.attempt.id}/confirm`, { method: 'POST', token: hodan, body: { reference: ref } })).status === 409);
chk('a rejection is told to the customer', (await call(`/operator/topups/${claim2.body.attempt.id}/reject`, { method: 'POST', token: hodan, body: { note: 'Not on the merchant phone' } })).status === 200
  && (await call('/wallet', { token: bob })).body.wallet.lastTopup.status === 'rejected');

console.log('\n── the inbox ──');
const inbox = (await call('/inbox', { token: alice })).body;
chk('the bell counts what happened', inbox.unread > 0 && inbox.items.some((i) => i.type === 'wallet') && inbox.items.some((i) => i.type === 'order'));
await call('/inbox/seen', { method: 'POST', token: alice, body: {} });
chk('read: the count is 0', (await call('/inbox', { token: alice })).body.unread === 0);
chk('the bob inbox has his suggestion decisions', ((await call('/inbox', { token: bob })).body.items || []).some((i) => i.type === 'submission'));

console.log('\n── AI Caawiye drafts ──');
const ordersBefore = sql('SELECT count(*) FROM orders');
const d1 = (await call('/assistant', { method: 'POST', token: alice, body: { message: 'order 2 rice and milk', lang: 'en' } })).body;
chk('"order 2 rice and milk" drafts a cart from the real catalog', d1.draft?.type === 'cart' && d1.draft.lines.some((l) => l.itemId === rice.id && l.qty === 2));
const d2 = (await call('/assistant', { method: 'POST', body: { message: 'Bajaj ii dalbo ilaa Bakaara', lang: 'so' } })).body;
chk('"Bajaj ii dalbo ilaa Bakaara" drafts a ride', d2.draft?.type === 'ride' && d2.draft.vehicle === 'bajaj' && d2.draft.to === 'bakaara');
const d3 = (await call('/assistant', { method: 'POST', body: { message: 'How do I pay for an order?', lang: 'en' } })).body;
chk('a question gets an answer, not a draft', !d3.draft && d3.source === 'faq');
chk('a draft changed nothing: no new order', sql('SELECT count(*) FROM orders') === ordersBefore);

console.log('\n── who may see what ──');
const aminaId = aminaCard.id;
chk('a driver photo needs a session', (await call(`/drivers/${aminaId}/photo`)).status === 401);
chk('a driver profile change is admin-only', (await call(`/operator/drivers/${aminaId}/profile`, { method: 'POST', token: hodan, body: { plate: 'X 1' } })).status === 403);
chk('a bad plate is refused', (await call(`/operator/drivers/${aminaId}/profile`, { method: 'POST', token: admin, body: { plate: '<b>' } })).status === 400);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
