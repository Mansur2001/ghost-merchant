// Rides, the priced cart, wallet payments, live driver location and who may see what — over
// real HTTP and WebSocket, against STAGING (it needs the WaafiPay simulator, which only
// staging runs). Reseeds staging first.
//
//   ./scripts/staging.sh up
//   cp scripts/verify/09-rides.mjs backend/.verify-tmp.mjs && \
//     (cd backend && NODE_TLS_REJECT_UNAUTHORIZED=0 node .verify-tmp.mjs); rm backend/.verify-tmp.mjs
//
// Copied into backend/ to run so `ws` resolves from backend/node_modules.
import { WebSocket } from 'ws';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
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
const WS_URL = `${BASE.replace(/^http/, 'ws')}/ws`;
const dc = 'docker compose -p gurikaabe-staging --env-file .env.staging -f docker-compose.yml -f docker-compose.staging.yml';
const sh = (cmd, input) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', input }).trim();
// The query goes in on stdin, so its quotes never meet the shell's.
const sql = (q) => sh(`${dc} exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA'`, q);
const money = (v) => Number(v).toFixed(2);

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  if (ok) { console.log(`  PASS  ${label}`); pass += 1; } else { console.log(`  FAIL  ${label} ${detail}`); fail += 1; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
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
    await sleep(400);
  }
}

console.log('── reseeding staging ──');
sh(`${dc} exec -T redis sh -c 'redis-cli --scan --pattern "rl:*" | xargs -r redis-cli DEL' >/dev/null 2>&1 || true`);
sh(`${dc} exec -T -e SEED_CONFIRM=wipe-local-data backend npm run seed >/dev/null 2>&1`);

// Two customers (password accounts) and the three seeded drivers.
async function customer(tag) {
  const email = `rides-${tag}-${Date.now()}@example.com`;
  const r = await call('/auth/signup', { method: 'POST', body: { email, password: `Sahan-${tag}-route-2026` } });
  return r.body.token;
}
const alice = await customer('a');
const bob = await customer('b');
chk('two customers signed up', Boolean(alice && bob));
const driver = async (msisdn, pin) => (await call('/driver/login', { method: 'POST', body: { msisdn, pin } })).body.token;
const amina = await driver('+252619876543', '1234');
const bashir = await driver('+252651112223', '5678');
const cali = await driver('+252631234567', '2468');
chk('three drivers signed in', Boolean(amina && bashir && cali));
const op = (await call('/operator/login', { method: 'POST', body: { username: 'admin', password: 'change-me-please-1' } })).body.token;
chk('operator signed in', Boolean(op));

console.log('\n── public catalog and places ──');
const cat = await call('/catalog');
const items = (cat.body.categories || []).flatMap((c) => c.items);
chk('catalog lists active items with prices', items.length >= 10 && items.every((i) => Number(i.price) > 0));
const places = (await call('/places')).body.places || [];
const stadium = places.find((p) => p.name_en === 'Mogadishu Stadium');
const airport = places.find((p) => p.name_en === 'Aden Adde Airport');
chk('places include markets and landmarks', Boolean(stadium && airport && places.some((p) => p.kind === 'market')));

console.log('\n── ride quote and booking ──');
const pickup = { lat: 2.0478, lng: 45.3291 };
const dropoff = { placeId: airport.id };
const noAuthQuote = await call('/quote', { method: 'POST', body: { kind: 'RIDE', pickup, dropoff } });
chk('quote needs a customer session', noAuthQuote.status === 401, `got ${noAuthQuote.status}`);
// The seed's waiting delivery would go to the first free driver who comes online — correct,
// but it would make Bashir busy. Stop it first so the car ride below has him.
const waitingDelivery = sql("SELECT id FROM orders WHERE kind = 'DELIVERY' AND status = 'PAID_UNASSIGNED' LIMIT 1");
if (waitingDelivery) await call(`/operator/orders/${waitingDelivery}/refund`, { method: 'POST', token: op, body: { reason: 'test setup' } });
// Bashir drives a car: put him near the pickup, online, with a fresh fix.
await call('/driver/online', { method: 'POST', token: bashir, body: { online: true } });
const loc = await call('/driver/location', { method: 'POST', token: bashir, body: { lat: 2.0470, lng: 45.3300, accuracy: 12 } });
chk('driver position accepted', loc.status === 200, JSON.stringify(loc.body));
const broken = await call('/driver/location', { method: 'POST', token: cali, body: { lat: 0, lng: 0, accuracy: 5 } });
chk('a (0, 0) "no fix yet" position is refused', broken.status === 400);
// Tracking works from abroad (the team tests from Seattle). Amina is offline with no job, so
// her dot moving doesn't change any dispatch below.
const abroad = await call('/driver/location', { method: 'POST', token: amina, body: { lat: 47.6, lng: -122.3, accuracy: 5 } });
chk('a position outside Somalia is kept for tracking', abroad.status === 200, JSON.stringify(abroad.body));
const q = await call('/quote', { method: 'POST', token: alice, body: { kind: 'RIDE', pickup, dropoff } });
const carOpt = q.body.quote?.options?.find((o) => o.vehicle === 'car');
const bajOpt = q.body.quote?.options?.find((o) => o.vehicle === 'bajaj');
chk('quote prices bajaj and car', Boolean(carOpt && bajOpt) && Number(carOpt.total) > Number(bajOpt.total), JSON.stringify(q.body));
chk('quote counts the free car nearby (count, not positions)', carOpt?.available >= 1 && !('lat' in carOpt));
const same = await call('/quote', { method: 'POST', token: alice, body: { kind: 'RIDE', pickup, dropoff: pickup } });
chk('pickup = destination is refused', same.status === 400);
const outside = await call('/quote', { method: 'POST', token: alice, body: { kind: 'RIDE', pickup, dropoff: { lat: 0, lng: 0 } } });
chk('a destination outside the area is refused', outside.status === 400);

const rideId = randomUUID();
const rideBody = { kind: 'RIDE', id: rideId, vehicle: 'car', pickup, dropoff, phone: '+252612345678', pickupNote: 'blue gate' };
const wrong = await call('/orders', { method: 'POST', token: alice, body: { ...rideBody, expectedTotal: '0.10' } });
chk('a stale price is refused with the fresh quote', wrong.status === 409 && Boolean(wrong.body.quote), `got ${wrong.status}`);
const booked = await call('/orders', { method: 'POST', token: alice, body: { ...rideBody, expectedTotal: carOpt.total } });
chk('ride booked at the quoted fare', booked.status === 201 && booked.body.order?.kind === 'RIDE' && money(booked.body.order.total_amount) === carOpt.total, JSON.stringify(booked.body).slice(0, 200));
const retry = await call('/orders', { method: 'POST', token: alice, body: { ...rideBody, expectedTotal: '0.10' } });
chk('a retry returns the same ride (200), even with a stale price', retry.status === 200 && retry.body.order?.id === rideId);
const stolenId = await call('/orders', { method: 'POST', token: bob, body: { ...rideBody, expectedTotal: carOpt.total } });
chk("another customer can't reuse that id", stolenId.status === 400);
chk('payment instruction offers in-app pay', (booked.body.appPay || []).some((w) => w.id === 'sahal'));

console.log('\n── who may see the ride ──');
chk("bob can't read alice's ride", (await call(`/orders/${rideId}`, { token: bob })).status === 404);
chk("bob can't pay for it", (await call(`/orders/${rideId}/pay`, { method: 'POST', token: bob, body: { wallet: 'sahal', phone: '901234567' } })).status === 404);
chk("bob can't cancel it", (await call(`/orders/${rideId}/cancel`, { method: 'POST', token: bob, body: {} })).status === 404);
chk("bob can't see its driver", (await call(`/orders/${rideId}/driver-location`, { token: bob })).status === 404);
chk('an unassigned driver can\'t open it', (await call(`/driver/orders/${rideId}`, { token: amina })).status === 404);

console.log('\n── in-app payment (WaafiPay simulator) ──');
const declined = await call(`/orders/${rideId}/pay`, { method: 'POST', token: alice, body: { wallet: 'sahal', phone: '901230000' } });
chk('prompt sent (202)', declined.status === 202 && declined.body.attempt?.status === 'pending');
const dbl = await call(`/orders/${rideId}/pay`, { method: 'POST', token: alice, body: { wallet: 'sahal', phone: '901230000' } });
chk('a double tap returns the same pending prompt', dbl.status === 202 && dbl.body.attempt?.attemptId === declined.body.attempt.attemptId);
const cancelDuring = await call(`/orders/${rideId}/cancel`, { method: 'POST', token: alice, body: {} });
chk("can't cancel while a prompt is pending", cancelDuring.status === 409);
const afterDecline = await waitFor(async () => {
  const a = (await call(`/orders/${rideId}/payment`, { token: alice })).body.attempt;
  return a && a.status !== 'pending' ? a : null;
});
chk('refused on the phone -> declined, order still unpaid', afterDecline?.status === 'declined'
  && (await call(`/orders/${rideId}`, { token: alice })).body.order.status === 'PENDING_PAYMENT');

// Watch the ride over the socket before paying, to see the driver's dot arrive live.
const ws = new WebSocket(WS_URL);
const frames = [];
await new Promise((resolve, reject) => {
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: alice })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    frames.push(m);
    if (m.type === 'authenticated') ws.send(JSON.stringify({ type: 'subscribe', orderId: rideId }));
    if (m.type === 'subscribed') resolve();
  });
  ws.on('error', reject);
});
const paid = await call(`/orders/${rideId}/pay`, { method: 'POST', token: alice, body: { wallet: 'sahal', phone: '901234567' } });
chk('second prompt accepted', paid.status === 202);
const dispatched = await waitFor(async () => {
  const o = (await call(`/orders/${rideId}`, { token: alice })).body.order;
  return o && o.status === 'DISPATCHED' ? o : null;
});
chk('approved -> paid -> dispatched to the nearby car (Bashir)', Boolean(dispatched)
  && sql(`SELECT name FROM drivers WHERE id = ${dispatched?.driver_id || 0}`) === 'Bashir');
chk('payment row recorded with the gateway reference', sql(`SELECT count(*) FROM transactions WHERE order_id = '${rideId}' AND provider = 'waafipay'`) === '1');
chk('socket said payment_attempt and order_state', frames.some((f) => f.type === 'payment_attempt') && frames.some((f) => f.type === 'order_state' && f.to === 'DISPATCHED'));
const payAgain = await call(`/orders/${rideId}/pay`, { method: 'POST', token: alice, body: { wallet: 'sahal', phone: '901234567' } });
chk('a paid order takes no further prompt', payAgain.status === 409);

console.log('\n── live driver location ──');
await sleep(4200); // the per-driver write throttle
await call('/driver/location', { method: 'POST', token: bashir, body: { lat: 2.0474, lng: 45.3296, accuracy: 9 } });
const seen = await waitFor(async () => frames.find((f) => f.type === 'driver_location' && f.orderId === rideId), 5000);
chk('the rider sees the driver move, over the socket', Boolean(seen) && Math.abs(seen.lat - 2.0474) < 1e-6);
const dl = await call(`/orders/${rideId}/driver-location`, { token: alice });
chk('first-paint driver location has name and vehicle, no phone', dl.body.location?.name === 'Bashir' && dl.body.location.vehicle === 'car' && !JSON.stringify(dl.body).includes('msisdn'));
chk("the rider's code isn't on the driver's view", !JSON.stringify((await call(`/driver/orders/${rideId}`, { token: bashir })).body).match(/"code"/));

console.log('\n── ride steps with proof ──');
const code = (await call(`/orders/${rideId}/handoff`, { token: alice })).body.code;
chk('rider has a 4-digit code', /^\d{4}$/.test(code || ''));
chk("driver can't read the code", (await call(`/orders/${rideId}/handoff`, { token: bashir })).status !== 200);
const bad = await call(`/driver/orders/${rideId}/secured`, { method: 'POST', token: bashir, body: { code: code === '0000' ? '1111' : '0000' } });
chk('a wrong code is refused and counted', bad.status === 422 && bad.body.triesLeft === 4, JSON.stringify(bad.body));
const deliveredEarly = await call(`/driver/orders/${rideId}/delivered`, { method: 'POST', token: bashir, body: { code } });
chk("a ride can't be finished with the delivery route", deliveredEarly.status === 409);
const picked = await call(`/driver/orders/${rideId}/secured`, { method: 'POST', token: bashir, body: { code, fix: { lat: 2.0478, lng: 45.3291, accuracy: 10 } } });
chk('right code -> trip started', picked.status === 200 && picked.body.order.status === 'IN_TRANSIT');
const releaseLate = await call(`/driver/orders/${rideId}/release`, { method: 'POST', token: bashir, body: { reason: 'too far' } });
chk("can't give a job back after pickup", releaseLate.status === 409);
const done = await call(`/driver/orders/${rideId}/dropoff`, { method: 'POST', token: bashir, body: { fix: { lat: airport.lat, lng: airport.lng, accuracy: 15 } } });
chk('drop-off at the destination -> arrived, nothing flagged', done.status === 200 && done.body.order.status === 'DELIVERED'
  && sql(`SELECT cardinality(flags) FROM order_proofs WHERE order_id = '${rideId}' AND step = 'delivery'`) === '0');
chk('after the trip the rider no longer sees the driver', (await call(`/orders/${rideId}/driver-location`, { token: alice })).body.location === null);
ws.close();

console.log('\n── priced delivery cart ──');
const rice = items.find((i) => i.name_en === 'Rice');
const milk = items.find((i) => i.name_en === 'Milk');
const cart = { lines: [{ itemId: rice.id, qty: 2 }, { itemId: milk.id, qty: 1 }, { itemId: milk.id, qty: 1 }], custom: { text: 'Red school shoes size 34', budget: 8 } };
const door = { lat: 2.0390, lng: 45.3260 };
const dq = await call('/quote', { method: 'POST', token: bob, body: { kind: 'DELIVERY', cart, dropoff: door } });
const expectSub = (Number(rice.price) * 2 + Number(milk.price) * 2 + 8).toFixed(2);
chk('cart priced from the catalog (duplicates merged, custom budget added)', dq.body.quote?.subtotal === expectSub, JSON.stringify(dq.body).slice(0, 300));
chk('fee from the nearest market', Boolean(dq.body.quote?.pickup?.label) && Number(dq.body.quote.fee) >= 1);
const tamper = await call('/quote', { method: 'POST', token: bob, body: { kind: 'DELIVERY', cart: { lines: [{ itemId: rice.id, qty: 1, price: '0.01' }] }, dropoff: door } });
chk('a client-sent price is ignored', tamper.body.quote?.subtotal === Number(rice.price).toFixed(2));
const delId = randomUUID();
const noLandmark = await call('/orders', { method: 'POST', token: bob, body: { kind: 'DELIVERY', id: randomUUID(), cart, dropoff: door, phone: '+252651234567' } });
chk('a delivery without a landmark is refused', noLandmark.status === 400);
const del = await call('/orders', { method: 'POST', token: bob, body: { kind: 'DELIVERY', id: delId, cart, dropoff: door, landmark: 'Red door', phone: '+252651234567', expectedTotal: dq.body.quote.total } });
chk('delivery placed at the quoted total', del.status === 201 && money(del.body.order.total_amount) === dq.body.quote.total
  && Number(del.body.order.subtotal) + Number(del.body.order.fee) === Number(del.body.order.total_amount));
chk('lines stored with names and prices (older apps read `text`)', del.body.order.items.every((i) => i.text) && del.body.order.items.some((i) => i.item_id === rice.id && i.unit_price === Number(rice.price).toFixed(2)));
// Hide milk: the cart now names an item that is no longer sold.
await call(`/operator/catalog/items/${milk.id}`, { method: 'PATCH', token: op, body: { active: false } });
const gone = await call('/quote', { method: 'POST', token: bob, body: { kind: 'DELIVERY', cart, dropoff: door } });
chk('a hidden item is refused with 409, not dropped silently', gone.status === 409);
chk('the price change is audited', sql("SELECT count(*) FROM audit_log WHERE action = 'catalog.item.updated'") === '1');
await call(`/operator/catalog/items/${milk.id}`, { method: 'PATCH', token: op, body: { active: true } });
const hodan = (await call('/operator/login', { method: 'POST', body: { username: 'hodan', password: 'seeded-operator-pw-1' } })).body.token;
chk('an ordinary operator cannot change prices', (await call(`/operator/catalog/items/${rice.id}`, { method: 'PATCH', token: hodan, body: { price: 0.5 } })).status === 403);
const legacy = await call('/orders', { method: 'POST', token: bob, body: { id: randomUUID(), phone: '+252651234567', items: [{ text: 'old app list' }], totalAmount: 5, landmark: 'x' } });
chk('the legacy order shape (installed old apps) still works', legacy.status === 201 && legacy.body.order.kind === 'DELIVERY');

console.log('\n── cancel and refunds ──');
// Places come sorted by city; the destination must be in Mogadishu like the pickup.
const lido = places.find((p) => p.name_en === 'Lido Beach');
const r2 = randomUUID();
const q2 = await call('/quote', { method: 'POST', token: alice, body: { kind: 'RIDE', pickup, dropoff: { placeId: lido.id } } });
const b2 = await call('/orders', { method: 'POST', token: alice, body: { kind: 'RIDE', id: r2, vehicle: 'bajaj', pickup, dropoff: { placeId: lido.id }, phone: '+252612345678', expectedTotal: q2.body.quote?.options.find((o) => o.vehicle === 'bajaj').total } });
chk('a second ride booked', b2.status === 201);
const c2 = await call(`/orders/${r2}/cancel`, { method: 'POST', token: alice, body: {} });
chk('unpaid ride cancelled; nothing owed', c2.status === 200 && c2.body.order.status === 'FAILED_REFUND'
  && sql(`SELECT count(*) FROM refunds WHERE order_id = '${r2}'`) === '0');
// A paid bajaj ride with no free bajaj: Amina has deliveries, Cali has a rider (seed). It waits.
const r3 = randomUUID();
await call('/orders', { method: 'POST', token: alice, body: { kind: 'RIDE', id: r3, vehicle: 'bajaj', pickup, dropoff: { placeId: lido.id }, phone: '+252612345678' } });
await call(`/orders/${r3}/pay`, { method: 'POST', token: alice, body: { wallet: 'evc', phone: '612345678' } });
const waiting = await waitFor(async () => {
  const o = (await call(`/orders/${r3}`, { token: alice })).body.order;
  return o && o.status !== 'PENDING_PAYMENT' ? o : null;
});
chk('paid with no free bajaj -> waits for a driver', waiting?.status === 'PAID_UNASSIGNED', waiting?.status);
const c3 = await call(`/orders/${r3}/cancel`, { method: 'POST', token: alice, body: {} });
chk('paid ride cancelled -> refund opened for the full fare', c3.status === 200
  && sql(`SELECT amount FROM refunds WHERE order_id = '${r3}' AND status = 'owed'`) === money(waiting.total_amount));

console.log('\n── release before pickup ──');
// Cali's seeded ride: he gives it back; it must not come back to him.
const caliRide = sql("SELECT id FROM orders WHERE kind = 'RIDE' AND status = 'DISPATCHED' LIMIT 1");
const rel = await call(`/driver/orders/${caliRide}/release`, { method: 'POST', token: cali, body: { reason: 'Vehicle problem' } });
chk('driver gave the job back', rel.status === 200);
chk('released ride is not given back to the same driver', sql(`SELECT coalesce(driver_id::text, 'none') FROM orders WHERE id = '${caliRide}'`) !== sql("SELECT id::text FROM drivers WHERE name = 'Cali'"));
chk('release is audited', sql("SELECT count(*) FROM audit_log WHERE action = 'order.released'") === '1');
chk("another driver can't release someone else's job", (await call(`/driver/orders/${caliRide}/release`, { method: 'POST', token: amina, body: { reason: 'x y z' } })).status === 404);

console.log('\n── customer wallet (staging has WALLET_ENABLED=true) ──');
const w0 = await call('/wallet', { token: bob });
chk('wallet starts empty', w0.body.wallet?.enabled === true && w0.body.wallet.balance === '0.00');
const tooBig = await call('/wallet/topup', { method: 'POST', token: bob, body: { amount: 900, wallet: 'sahal', phone: '901234567' } });
chk('a top-up over the limit is refused before any prompt', tooBig.status === 400);
const top = await call('/wallet/topup', { method: 'POST', token: bob, body: { amount: 20, wallet: 'sahal', phone: '901234567' } });
chk('top-up prompt sent', top.status === 202);
const credited = await waitFor(async () => {
  const w = (await call('/wallet', { token: bob })).body.wallet;
  return w && w.balance === '20.00' ? w : null;
});
chk('approved top-up credited exactly once, with a ledger row', Boolean(credited) && credited.entries.length === 1 && credited.entries[0].kind === 'topup');
chk('the top-up is recorded as a payment with its gateway reference', sql("SELECT count(*) FROM transactions WHERE order_id IS NULL AND provider = 'waafipay'") === '1');
const declinedTop = await call('/wallet/topup', { method: 'POST', token: bob, body: { amount: 5, wallet: 'sahal', phone: '901230000' } });
await waitFor(async () => (await call('/wallet', { token: bob })).body.wallet.lastTopup?.status === 'declined');
chk('a refused top-up credits nothing', declinedTop.status === 202 && (await call('/wallet', { token: bob })).body.wallet.balance === '20.00');
// Pay an order from the wallet.
const wq = await call('/quote', { method: 'POST', token: bob, body: { kind: 'DELIVERY', cart: { lines: [{ itemId: rice.id, qty: 1 }] }, dropoff: door } });
const wOrder = randomUUID();
await call('/orders', { method: 'POST', token: bob, body: { kind: 'DELIVERY', id: wOrder, cart: { lines: [{ itemId: rice.id, qty: 1 }] }, dropoff: door, landmark: 'Wallet door', phone: '+252651234567' } });
chk("alice can't pay bob's order from her wallet", (await call(`/orders/${wOrder}/pay-wallet`, { method: 'POST', token: alice, body: {} })).status === 404);
const paidW = await call(`/orders/${wOrder}/pay-wallet`, { method: 'POST', token: bob, body: {} });
const afterPay = (await call('/wallet', { token: bob })).body.wallet;
chk('order paid from the wallet; balance down by the total', paidW.status === 200 && paidW.body.order.status !== 'PENDING_PAYMENT'
  && Number(afterPay.balance) === Number((20 - Number(wq.body.quote.total)).toFixed(2)));
chk('paying the same order twice is refused, nothing taken', (await call(`/orders/${wOrder}/pay-wallet`, { method: 'POST', token: bob, body: {} })).status === 409
  && (await call('/wallet', { token: bob })).body.wallet.balance === afterPay.balance);
// The order fails: the money goes straight back to the wallet, refund settled by the system.
await call(`/operator/orders/${wOrder}/refund`, { method: 'POST', token: op, body: { reason: 'out of stock' } });
const afterRefund = await waitFor(async () => {
  const w = (await call('/wallet', { token: bob })).body.wallet;
  return w.balance === '20.00' ? w : null;
});
chk('a failed wallet-paid order is refunded to the wallet at once', Boolean(afterRefund)
  && sql(`SELECT status || '/' || settled_by FROM refunds WHERE order_id = '${wOrder}'`) === 'settled/system:wallet');
// Not enough money.
const big = randomUUID();
await call('/orders', { method: 'POST', token: bob, body: { kind: 'DELIVERY', id: big, cart: { lines: [{ itemId: rice.id, qty: 20 }] }, dropoff: door, landmark: 'x', phone: '+252651234567' } });
chk('an order larger than the balance is refused, nothing taken', (await call(`/orders/${big}/pay-wallet`, { method: 'POST', token: bob, body: {} })).status === 409
  && (await call('/wallet', { token: bob })).body.wallet.balance === '20.00');
// Withdraw: taken at request; rejected -> returned; requested again -> paid with a reference.
const wd = await call('/wallet/withdrawals', { method: 'POST', token: bob, body: { amount: 15, phone: '901234567' } });
chk('withdrawal requested; the amount leaves the balance at once', wd.status === 201 && (await call('/wallet', { token: bob })).body.wallet.balance === '5.00');
chk('a second withdrawal while one waits is refused', (await call('/wallet/withdrawals', { method: 'POST', token: bob, body: { amount: 1, phone: '901234567' } })).status === 409);
chk('an ordinary operator cannot pay out', (await call(`/operator/withdrawals/${wd.body.withdrawal.id}/paid`, { method: 'POST', token: hodan, body: { reference: 'X1' } })).status === 403);
const rej = await call(`/operator/withdrawals/${wd.body.withdrawal.id}/reject`, { method: 'POST', token: op, body: { note: 'wrong number' } });
chk('rejected -> back in the balance', rej.status === 200 && (await call('/wallet', { token: bob })).body.wallet.balance === '20.00');
const wd2 = await call('/wallet/withdrawals', { method: 'POST', token: bob, body: { amount: 10, phone: '901234567' } });
chk('paying out needs the reference', (await call(`/operator/withdrawals/${wd2.body.withdrawal.id}/paid`, { method: 'POST', token: op, body: {} })).status === 400);
const paidOut = await call(`/operator/withdrawals/${wd2.body.withdrawal.id}/paid`, { method: 'POST', token: op, body: { reference: 'SAHAL998877' } });
chk('paid out with the reference, audited; decided twice is refused', paidOut.status === 200
  && sql("SELECT count(*) FROM audit_log WHERE action = 'wallet.withdrawal.paid'") === '1'
  && (await call(`/operator/withdrawals/${wd2.body.withdrawal.id}/reject`, { method: 'POST', token: op, body: { note: 'x' } })).status === 409);
const ledgerSum = sql('SELECT coalesce(sum(amount_cents),0) FROM wallet_entries');
const balSum = sql('SELECT coalesce(sum(balance_cents),0) FROM wallet_accounts');
chk('the ledger adds up to the balances', ledgerSum === balSum, `${ledgerSum} vs ${balSum}`);
let ledgerEdit = 'refused';
try { sql('UPDATE wallet_entries SET amount_cents = 999999'); ledgerEdit = 'allowed'; } catch { /* the trigger refused */ }
chk('the wallet ledger cannot be edited', ledgerEdit === 'refused');

console.log('\n── operator map ──');
const map = await call('/operator/map', { token: op });
chk('operator sees driver positions', (map.body.drivers || []).some((d) => d.name === 'Bashir'));
chk('customers cannot read the operator map', (await call('/operator/map', { token: alice })).status === 401 || (await call('/operator/map', { token: alice })).status === 403);
const offline = await call('/driver/online', { method: 'POST', token: bashir, body: { online: false } });
chk('driver can go offline', offline.status === 200 && offline.body.driver.online === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
