// A day at GuriKaabe, played out on staging through the real apps — a customer's phone, the
// driver's phone, the operator's desk — with a screenshot of every step and a check of what
// each person should see. Tests prove rules; this shows the product working, end to end.
//
//   ./scripts/staging.sh simulate      -> e2e/simulation/report.html
//
// Staging data only (it never sends a real text or email: codes show on screen). The customer
// side runs in EMAIL-ONLY mode, the way production does with no Twilio.
import { chromium, devices } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = process.env.STAGING_URL || 'https://localhost:8444';
const OUT = new URL('./simulation/', import.meta.url).pathname;
const PHOTO = new URL('../frontend/user/icon-512.png', import.meta.url).pathname;
const PIN = { latitude: 2.0469, longitude: 45.3182 }; // the customer's drop-off
const DOOR = { latitude: 2.0471, longitude: 45.3184 }; // ~25 m away
const FAR = { latitude: 2.0650, longitude: 45.3182 }; // ~2 km away

const steps = [];
let shotNo = 0;
let failures = 0;

function scenario(title, intro) { steps.push({ scenario: title, intro }); }

// One step: who did what, what should be true, and the screen to prove it.
async function step(page, who, did, expect, check) {
  let ok = true;
  let note = '';
  try { await check(); } catch (err) { ok = false; failures += 1; note = String(err.message).split('\n')[0].slice(0, 240); }
  let shot = null;
  if (page) {
    shotNo += 1;
    shot = `${String(shotNo).padStart(2, '0')}.png`;
    await page.screenshot({ path: join(OUT, shot) }).catch(() => { shot = null; });
  }
  steps.push({ who, did, expect, ok, note, shot });
  console.log(`${ok ? '✓' : '✗'} [${who}] ${did}${ok ? '' : ` — ${note}`}`);
}

const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const waitText = async (loc, re, ms = 10000) => {
  await loc.waitFor({ state: 'visible', timeout: ms });
  const until = Date.now() + ms;
  for (;;) {
    const txt = (await loc.textContent()) || '';
    if (re.test(txt)) return txt;
    if (Date.now() > until) throw new Error(`expected ${re} but saw “${txt.trim().slice(0, 120)}”`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

const browser = await chromium.launch();
const phone = { ...devices['Pixel 7'], ignoreHTTPSErrors: true, locale: 'en-US' };

async function device(kind, extra = {}) {
  const ctx = await browser.newContext(kind === 'desk'
    ? { viewport: { width: 1366, height: 860 }, ignoreHTTPSErrors: true, locale: 'en-US', ...extra }
    : { ...phone, ...extra });
  await ctx.addInitScript(() => { try { localStorage.setItem('gm_lang', 'en'); } catch {} });
  const page = await ctx.newPage();
  return { ctx, page };
}

// Production without Twilio: the server says "no SMS", so sign-in is email only.
async function emailOnly(page) {
  await page.route('**/api/auth/channels', (r) => r.fulfill({ json: { sms: false, email: true } }));
}

// The everyday way in: email + password, no email has to arrive.
const SIM_PASSWORD = 'market day 2026';
async function customerSignsUp(page, email) {
  await page.goto(BASE + '/');
  await page.click('#asCustomer');
  await page.fill('#pwEmail', email);
  await page.fill('#pwPass', SIM_PASSWORD);
  await page.fill('#pwPass2', SIM_PASSWORD);
  await page.click('#pwBtn');
  await page.waitForSelector('#homeView', { state: 'visible' });
}

// The emailed-code way in (proving the address, or "forgot password").
async function customerSignsInByCode(page, email) {
  await page.goto(BASE + '/');
  await page.click('#asCustomer');
  await page.click('#useCode');
  await page.waitForSelector('#signinEmail', { state: 'visible' });
  await page.fill('#signinEmail', email);
  await page.click('#sendCodeBtn');
  const status = await waitText(page.locator('#otpStatus'), /\d{6}/);
  await page.fill('#codeInput', status.match(/\d{6}/)[0]);
  await page.click('#verifyBtn');
  await page.waitForSelector('#homeView', { state: 'visible' });
}

// From the catalog: two items, plus a custom line with a budget and a photo. The server prices it.
async function placeOrder(page, { what, amount, landmark, phoneNo }) {
  await page.click('.tabbar [data-tab="home"]');
  await page.click('#goShop');
  await page.locator('#catItems .step-add').first().click();
  await page.locator('#catItems .step-add').first().click();
  await page.click('#cartOpen');
  await page.waitForSelector('#startView', { state: 'visible' });
  await page.click('#customBox summary');
  await page.fill('#request', what);
  await page.fill('#budget', amount);
  await page.setInputFiles('#refPhoto', PHOTO);
  await page.click('#locBtn');
  await waitText(page.locator('#locStatus'), /±/);
  await page.fill('#landmark', landmark);
  await page.fill('#orderPhone', phoneNo);
  await waitText(page.locator('#qTotal'), /^\d+\.\d{2}$/);
  await page.click('#submitBtn');
  await page.waitForSelector('#orderView', { state: 'visible' });
  const short = (await page.textContent('#orderId')).trim();
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('gm_last')).orderId);
  return { short, id };
}

async function operatorLogin(page) {
  await page.goto(BASE + '/operator/');
  await page.fill('#username', 'hodan');
  await page.fill('#password', 'seeded-operator-pw-1');
  await page.click('#loginBtn');
  await page.waitForSelector('#orders', { state: 'visible' });
}
const section = (page, id) => page.locator(`[data-nav="${id}"]:visible`).first().click();

async function driverLogin(page, msisdn = '619876543', pin = '1234') {
  await page.goto(BASE + '/driver/');
  // Already signed in on this phone: the app goes straight to the job list.
  if (await page.waitForSelector('#queueView', { state: 'visible', timeout: 1500 }).catch(() => null)) return;
  await page.fill('#msisdn', msisdn);
  await page.fill('#pin', pin);
  await page.click('#loginBtn');
  await page.waitForSelector('#queueView', { state: 'visible' });
}

// The operator confirms the payment; the SYSTEM picks the driver. Returns who it picked.
async function payAndDispatch(op, order, ref) {
  const card = op.locator(`#orders [data-open="${order.id}"]`);
  await card.waitFor();
  await card.click();
  await op.fill(`[data-payref="${order.id}"]`, ref);
  await op.click(`[data-confirm="${order.id}"]`);
  await waitText(card, /Driver assigned/);
  const txt = await waitText(op.locator('#orderDetail'), /🛵 \w+/);
  return txt.match(/🛵 (\w+)/)[1];
}

// One phone per driver, signed in as them.
const DRIVERS = { Amina: ['619876543', '1234'], Bashir: ['651112223', '5678'], Cali: ['631234567', '2468'] };
const driverPhones = {};
async function driverFor(name, geo = DOOR) {
  if (!DRIVERS[name]) throw new Error(`dispatched to unknown driver ${name}`);
  if (!driverPhones[name]) driverPhones[name] = await device('phone', { permissions: ['geolocation'], geolocation: geo });
  const dv = driverPhones[name];
  await dv.ctx.setGeolocation(geo);
  await driverLogin(dv.page, ...DRIVERS[name]);
  return dv;
}

const api = (page, path, opts = {}) => page.evaluate(async ([p, o]) => {
  const token = sessionStorage.getItem('driverToken') || localStorage.getItem('gm_token');
  const r = await fetch('/api' + p, { ...o, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(o.headers || {}) } });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}, [path, opts]);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const stamp = Date.now().toString().slice(-6);

// The shift starts: Amina goes online (she picks up the order already waiting for a driver).
const shift = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: BASE });
{
  const login = await shift.request.post('/api/driver/login', { data: { msisdn: '+252619876543', pin: '1234' } });
  const { token } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };
  await shift.request.post('/api/driver/online', { headers, data: { online: true } });
  await shift.request.post('/api/driver/location', { headers, data: { lat: 2.0469, lng: 45.3182, accuracy: 15 } });
}

// ═══ E (first: a ride needs a free car) ═══
scenario('E. A ride, paid in the app',
  'A rider books a car from the stadium to the airport, pays with Sahal in the app (staging simulates the gateway), the nearest free car comes, the rider gives their code at pickup, and the trip ends at the airport.');
const PICKUP = { latitude: 2.0478, longitude: 45.3291 };
driverPhones.Bashir = await device('phone', { permissions: ['geolocation'], geolocation: { latitude: 2.0471, longitude: 45.3300 } });
const bas = driverPhones.Bashir;
await driverLogin(bas.page, ...DRIVERS.Bashir);
await step(bas.page, 'Driver', 'Bashir (car) signs in and taps “Go online”', '“You are online”, sharing his location', async () => {
  if ((await bas.page.textContent('#onlineState')).includes('offline')) await bas.page.click('#onlineBtn');
  await waitText(bas.page.locator('#onlineState'), /You are online/);
  await waitText(bas.page.locator('#locLine'), /Sharing your location/);
});
const rider = await device('phone', { permissions: ['geolocation'], geolocation: PICKUP });
await emailOnly(rider.page);
await customerSignsUp(rider.page, `sim-ride-${stamp}@example.com`);
await step(rider.page, 'Rider', 'Opens the app', 'Home: “Ride” first, then “Food & shopping”', async () => {
  must(await rider.page.isVisible('#goRide') && await rider.page.isVisible('#goShop'), 'services missing');
});
await rider.page.click('#goRide');
await step(rider.page, 'Rider', 'Taps Ride', 'The map finds them: pickup “My location (±… m)”', async () => {
  await waitText(rider.page.locator('#pickupText'), /My location/);
});
await step(rider.page, 'Rider', 'Searches “Airport” and picks it', 'Fares for bajaj and car, with time, distance and drivers nearby', async () => {
  await rider.page.fill('#placeSearch', 'Airport');
  await rider.page.locator('#placeResults .place-result').first().click();
  await waitText(rider.page.locator('#rideOptions'), /Car/);
  await waitText(rider.page.locator('#rideOptions .ride-option', { hasText: 'Car' }), /1 nearby/);
});
let R;
await step(rider.page, 'Rider', 'Chooses Car and books', 'Tracking screen “Awaiting payment”, with the route on the map', async () => {
  await rider.page.locator('#rideOptions .ride-option', { hasText: 'Car' }).click();
  await rider.page.fill('#ridePhone', '612345678');
  await rider.page.click('#rideBook');
  await rider.page.waitForSelector('#orderView', { state: 'visible' });
  R = { id: await rider.page.evaluate(() => JSON.parse(localStorage.getItem('gm_last')).orderId) };
  await waitText(rider.page.locator('#statusTitle'), /Awaiting payment/);
  must(await rider.page.isVisible('#orderMapCard'), 'no map');
});
await step(rider.page, 'Rider', 'Taps “Pay with Sahal”, approves on the phone', 'Paid with no operator; the nearest car is sent: “Driver on the way”, Bashir on the map', async () => {
  await rider.page.fill('#payPhone', '901234567');
  await rider.page.locator('#appPayButtons button', { hasText: 'Sahal' }).click();
  await waitText(rider.page.locator('#statusTitle'), /Driver on the way/, 20000);
  await waitText(rider.page.locator('#driverName'), /Bashir/);
});
const rideCode = (await rider.page.textContent('#handoffCode')).trim();
await step(bas.page, 'Driver', 'Gets the job (phone buzzes) and opens it', 'Map, “Pick up the rider”, the fare — no shopping list', async () => {
  await bas.page.click('#refreshBtn');
  await bas.page.locator(`#queue [data-id="${R.id}"]`).click();
  await waitText(bas.page.locator('#dTargetTitle'), /Pick up the rider/);
  must(await bas.page.isHidden('#shopCard'), 'shopping list shown for a ride');
});
await step(bas.page, 'Driver', `Rider gets in and says the code (${rideCode})`, '“Take the rider to” the airport', async () => {
  await bas.page.fill('#codeIn', rideCode);
  await bas.page.click('#rideStartBtn');
  await waitText(bas.page.locator('#dTargetTitle'), /Take the rider to/);
});
await step(rider.page, 'Rider', 'Sees the trip start', '“On your trip”', async () => {
  await waitText(rider.page.locator('#statusTitle'), /On your trip/);
});
await bas.ctx.setGeolocation({ latitude: 2.0144, longitude: 45.3047 });
await step(bas.page, 'Driver', 'At the airport, taps “End trip”', 'Done; back to the job list', async () => {
  await bas.page.click('#rideEndBtn');
  await bas.page.waitForSelector('#queueView', { state: 'visible', timeout: 10000 });
});
await step(rider.page, 'Rider', 'Sees the end', '“Arrived” and “Picked up with your code”', async () => {
  await waitText(rider.page.locator('#statusTitle'), /Arrived/);
  await waitText(rider.page.locator('#proofList'), /Picked up with your code/);
});
await step(rider.page, 'Rider', 'Taps the chat button and asks “How do I get my money back?”', 'The chat panel opens; an answer from the FAQ, and “Talk to a person”', async () => {
  await rider.page.click('#chatLauncher');
  await rider.page.fill('#helpInput', 'How do I get my money back?');
  await rider.page.click('#helpSend');
  await waitText(rider.page.locator('#helpThread .msg').last(), /cancel/);
  must(await rider.page.isVisible('#helpHuman'), 'no handoff button');
});

// ═══ A ═══
scenario('A. A normal order, start to finish',
  'A new customer signs up with only an email, orders, pays from their phone, and receives it. The driver must photograph the goods and get the customer’s code.');
const cust = await device('phone', { permissions: ['geolocation'], geolocation: PIN });
await emailOnly(cust.page);
await step(cust.page, 'Customer', 'Opens the app for the first time', 'Landing page with “Start an order”', async () => {
  await cust.page.goto(BASE + '/');
  must(await cust.page.isVisible('#asCustomer'), 'no Start button');
});
await cust.page.click('#asCustomer');
await step(cust.page, 'Customer', 'Taps “Create account” (email-only server)', 'Email + password form; no phone box, because SMS is off', async () => {
  await cust.page.waitForSelector('#pwEmail', { state: 'visible' });
  must(await cust.page.isVisible('#pwPass2'), 'no repeat-password box on sign-up');
  must(await cust.page.isHidden('#phone'), 'phone box shown');
});
const email = `sim-${stamp}@example.com`;
await customerSignsUp(cust.page, email);
await step(cust.page, 'Customer', `Creates an account with ${email} and a password`, 'Lands on Home, signed in — no email had to arrive', async () => {
  await waitText(cust.page.locator('#signedInAs'), new RegExp(email));
});
let A;
await step(cust.page, 'Customer', 'Writes the list, sets GPS location, adds a photo and landmark, places the order', 'Tracking screen: “Awaiting payment”, a pay card', async () => {
  A = await placeOrder(cust.page, { what: 'Rice 2kg, cooking oil 1L, 6 eggs', amount: '7.50', landmark: 'Green gate next to the yellow pharmacy', phoneNo: '612345678' });
  await waitText(cust.page.locator('#statusBadge'), /Awaiting payment/);
  must(await cust.page.isVisible('#payCard'), 'no pay card');
  must(await cust.page.isHidden('#handoffCard'), 'delivery code shown before payment');
});
await step(cust.page, 'Customer', 'Pays the merchant by USSD, then taps “I’ve paid” with the transaction number', 'Told to wait for the operator — still NOT paid', async () => {
  await cust.page.fill('#payRef', `SIM${stamp}`);
  await cust.page.click('#paidBtn');
  await cust.page.waitForSelector('#paidNote', { state: 'visible' });
  await waitText(cust.page.locator('#statusBadge'), /Awaiting payment/);
});

const op = await device('desk');
await operatorLogin(op.page);
await step(op.page, 'Operator', 'Opens the dispatch console and selects the claimed order', 'It is first under “Payment to check”; the detail panel has the reference pre-filled', async () => {
  const card = op.page.locator(`#orders [data-open="${A.id}"]`);
  await waitText(card, /Customer says they paid/);
  await card.click();
  must((await op.page.inputValue(`[data-payref="${A.id}"]`)) === `SIM${stamp}`, 'reference not pre-filled');
});
await step(op.page, 'Operator', 'Checks the merchant phone and confirms the payment (transaction number required)', 'The SYSTEM assigns a driver at once — “Driver assigned”, “assigned automatically”', async () => {
  A.driver = await payAndDispatch(op.page, A, `SIM${stamp}`);
  await waitText(op.page.locator('#orderDetail'), /assigned automatically/);
});
await step(op.page, 'Operator', 'Looks for a way to choose or change the driver', 'There is none: no driver picker anywhere on the order', async () => {
  must(await op.page.locator('#orderDetail select').count() === 0, 'a driver picker exists');
  must(await op.page.locator('#orderDetail [data-assignbtn]').count() === 0, 'an assign button exists');
});
let code;
await step(cust.page, 'Customer', 'Watches the order (no reload)', 'Paid → driver getting items; a 4-digit delivery code appears', async () => {
  await waitText(cust.page.locator('#statusBadge'), /Driver getting your items/);
  await cust.page.waitForSelector('#handoffCard', { state: 'visible' });
  code = (await cust.page.textContent('#handoffCode')).trim();
  must(/^\d{4}$/.test(code), `code looks wrong: ${code}`);
});

let drv = await driverFor(A.driver);
await step(drv.page, 'Driver', 'Signs in with phone + PIN', 'Sees only the jobs assigned to them, with counts', async () => {
  await drv.page.waitForSelector(`#queue [data-id="${A.id}"]`);
});
await drv.page.click(`#queue [data-id="${A.id}"]`);
await step(drv.page, 'Driver', 'Opens the job at the market', 'Step 1 “Pick up”; Confirm pickup is LOCKED until there is a photo', async () => {
  await drv.page.waitForSelector('#pickBtn');
  must(await drv.page.isDisabled('#pickBtn'), 'pickup possible without a photo');
});
await step(drv.page, 'Driver', 'Buys the items and photographs them', 'Photo saved; Confirm pickup unlocks', async () => {
  await drv.page.setInputFiles('#pickPhoto', PHOTO);
  await drv.page.waitForSelector('#pickCap.done');
  must(await drv.page.isEnabled('#pickBtn'), 'still locked');
});
await step(drv.page, 'Driver', 'Taps Confirm pickup', 'Step 2 “Deliver”: asks for the customer’s code', async () => {
  await drv.page.click('#pickBtn');
  await drv.page.waitForSelector('#codeIn', { state: 'visible' });
});
await step(cust.page, 'Customer', 'Sees the update', '“On the way to you” and proof: driver photographed the items', async () => {
  await waitText(cust.page.locator('#statusBadge'), /On the way to you/);
  await waitText(cust.page.locator('#proofList'), /photographed your items/);
});
const wrong = code === '0000' ? '1111' : '0000';
await step(drv.page, 'Driver', `At the door, types a wrong code (${wrong})`, 'Refused: “Wrong code. 4 tries left.” — order stays on the way', async () => {
  await drv.page.fill('#codeIn', wrong);
  await drv.page.click('#deliverBtn');
  await waitText(drv.page.locator('#codeMsg'), /4 tries left/);
});
await step(drv.page, 'Driver', `Customer reads out the real code (${code}); driver confirms`, 'Delivered; back to the job list', async () => {
  await drv.page.fill('#codeIn', code);
  await drv.page.click('#deliverBtn');
  await drv.page.waitForSelector('#queueView', { state: 'visible', timeout: 10000 });
});
await step(cust.page, 'Customer', 'Sees the end of the order', '“Delivered”, “Delivered with your code”, code card gone', async () => {
  await waitText(cust.page.locator('#statusBadge'), /Delivered/);
  await waitText(cust.page.locator('#proofList'), /Delivered with your code/);
  must(await cust.page.isHidden('#handoffCard'), 'used code still shown');
});
await cust.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await step(cust.page, 'Customer', 'Scrolls the tracking page', 'Timeline with real times for each step, and the chat history', async () => {
  await waitText(cust.page.locator('#timeline'), /Delivered/);
});
await step(cust.page, 'Customer', 'Signs out, then signs back in with email + password', 'Signed in at once, and the delivered order is still in “Orders”', async () => {
  await cust.page.click('.tabbar [data-tab="account"]');
  await cust.page.click('#signOutBtn');
  await cust.page.click('#asSignin');
  await cust.page.fill('#pwEmail', email);
  await cust.page.fill('#pwPass', SIM_PASSWORD);
  await cust.page.click('#pwBtn');
  await cust.page.waitForSelector('#homeView', { state: 'visible' });
  await cust.page.click('.tabbar [data-tab="orders"]');
  await waitText(cust.page.locator('#resumeList'), /Delivered/);
});
await section(op.page, 'deliveries');
await step(op.page, 'Operator', 'Opens Deliveries and selects the order', 'Proven by code, GPS ~25 m from the pin, photos — nothing to check', async () => {
  const row = op.page.locator(`#deliveries [data-open="${A.id}"]`);
  await waitText(row, /Proven/);
  await row.click();
  const card = op.page.locator('#deliveryDetail');
  await waitText(card, /Customer gave the code/);
  await waitText(card, /m from the customer/);
});

// ═══ B ═══
scenario('B. The customer can’t give the code',
  'The customer’s phone is dead at the door. The driver delivers with a door photo and a reason — and is also far from the pin. The office must check it. Later the customer says it never arrived.');
const custB = await device('phone', { permissions: ['geolocation'], geolocation: PIN });
await emailOnly(custB.page);
await customerSignsUp(custB.page, `sim-b-${stamp}@example.com`);
const B = await placeOrder(custB.page, { what: 'Sugar 1kg, tea, powdered milk', amount: '4.25', landmark: 'Blue door behind the mosque', phoneNo: '651234567' });
await section(op.page, 'orders');
B.driver = await payAndDispatch(op.page, B, `SIMB${stamp}`);
const drvB = await driverFor(B.driver, FAR);
await drvB.page.click(`#queue [data-id="${B.id}"]`);
await drvB.page.setInputFiles('#pickPhoto', PHOTO);
await drvB.page.waitForSelector('#pickCap.done');
await drvB.page.click('#pickBtn');
await drvB.page.waitForSelector('#codeIn', { state: 'visible' });
await drvB.page.click('#noCodeBox summary');
await step(drvB.page, 'Driver', 'Opens “Customer can’t give the code?”', 'Needs a door photo first: “Deliver with photo” is locked', async () => {
  must(await drvB.page.isDisabled('#deliverPhotoBtn'), 'can deliver without a photo');
});
await step(drvB.page, 'Driver', 'Takes the door photo, picks “Customer’s phone is off or dead”, delivers', 'Delivered (flagged for the office)', async () => {
  await drvB.page.setInputFiles('#doorPhoto', PHOTO);
  await drvB.page.waitForSelector('#doorCap.done');
  await drvB.page.click('#deliverPhotoBtn');
  await drvB.page.waitForSelector('#queueView', { state: 'visible', timeout: 10000 });
});
await section(op.page, 'deliveries');
await step(op.page, 'Operator', 'Opens Deliveries and selects the flagged one', 'Under “To check”: “No customer code” and “Far from the pin”', async () => {
  const row = op.page.locator(`#deliveries [data-open="${B.id}"]`);
  await waitText(row, /Check/);
  await row.click();
  const card = op.page.locator('#deliveryDetail');
  await waitText(card, /No customer code/);
  await waitText(card, /Far from the pin/);
});
await step(op.page, 'Operator', 'Calls the customer, looks at the photos, taps Mark checked', '“Checked by hodan”', async () => {
  await op.page.locator('#deliveryDetail [data-review]').click();
  await waitText(op.page.locator('#deliveryDetail'), /Checked by/);
});
await custB.page.reload();
await custB.page.waitForSelector('#orderView', { state: 'visible' }).catch(async () => {
  await custB.page.click('.tabbar [data-tab="orders"]');
  await custB.page.locator(`#resumeList [data-id="${B.id}"]`).click();
});
await step(custB.page, 'Customer', 'Sees the delivery “with a photo (no code)” and taps “I didn’t get my order” twice', '“We are checking this and will call you”', async () => {
  if (!(await custB.page.isVisible('#orderView'))) {
    await custB.page.click('.tabbar [data-tab="orders"]');
    await custB.page.locator(`#resumeList [data-id="${B.id}"]`).click();
  }
  await waitText(custB.page.locator('#proofList'), /no code/);
  await custB.page.click('#disputeBtn');
  await custB.page.click('#disputeBtn');
  await custB.page.waitForSelector('#disputeNote', { state: 'visible' });
});
await step(op.page, 'Operator', 'Watches the desk (no reload)', 'Back in “To check”: “Customer says not received — call them”', async () => {
  await waitText(op.page.locator('#deliveryDetail'), /Customer says not received/);
  await waitText(op.page.locator(`#deliveries [data-open="${B.id}"]`), /Check/);
});

// ═══ C ═══
scenario('C. The driver delivers in a dead zone',
  'No signal at the door. The driver still finishes the delivery; it is saved on the phone and sent when the signal returns. The server still checks the code.');
const custC = await device('phone', { permissions: ['geolocation'], geolocation: PIN });
await emailOnly(custC.page);
await customerSignsUp(custC.page, `sim-c-${stamp}@example.com`);
const C = await placeOrder(custC.page, { what: 'Bread x3, butter', amount: '3.20', landmark: 'Corner shop, blue awning', phoneNo: '771234567' });
await section(op.page, 'orders');
C.driver = await payAndDispatch(op.page, C, `SIMC${stamp}`);
await custC.page.waitForSelector('#handoffCard', { state: 'visible' });
const codeC = (await custC.page.textContent('#handoffCode')).trim();
drv = await driverFor(C.driver);
await drv.page.click(`#queue [data-id="${C.id}"]`);
await drv.page.setInputFiles('#pickPhoto', PHOTO);
await drv.page.waitForSelector('#pickCap.done');
await drv.page.click('#pickBtn');
await drv.page.waitForSelector('#codeIn', { state: 'visible' });
await drv.ctx.setOffline(true);
await step(drv.page, 'Driver', `Signal drops. Enters the code (${codeC}) and confirms anyway`, '“Saved — will send when you have signal”; marked waiting to send', async () => {
  await drv.page.fill('#codeIn', codeC);
  await drv.page.click('#deliverBtn');
  await waitText(drv.page.locator('#syncState'), /1/);
});
await step(custC.page, 'Customer', 'Meanwhile', 'Still “On the way to you” — nothing reached the server yet', async () => {
  await waitText(custC.page.locator('#statusBadge'), /On the way to you/);
});
await drv.ctx.setOffline(false);
await drv.page.evaluate(() => window.dispatchEvent(new Event('online')));
await step(custC.page, 'Customer', 'Driver’s signal returns', 'The queued delivery syncs: “Delivered with your code”', async () => {
  await waitText(custC.page.locator('#statusBadge'), /Delivered/, 20000);
  await waitText(custC.page.locator('#proofList'), /Delivered with your code/);
});

// ═══ D ═══
scenario('D. Trying to cheat',
  'Each of these is a request someone could make with a modified app or a script. The server must refuse every one.');
const custD = await device('phone', { permissions: ['geolocation'], geolocation: PIN });
await emailOnly(custD.page);
await customerSignsUp(custD.page, `sim-d-${stamp}@example.com`);
const D = await placeOrder(custD.page, { what: 'Flour 5kg', amount: '6.00', landmark: 'White building', phoneNo: '612345678' });
// What the customer paid: the server's total for the cart, not a number typed here.
D.total = `$${(await custD.page.textContent('#orderTotal')).trim()}`;
await section(op.page, 'orders');
D.driver = await payAndDispatch(op.page, D, `SIMD${stamp}`);
drv = await driverFor(D.driver);
await step(null, 'Driver', 'Asks the server for the customer’s delivery code', 'Refused (customers only) and no code in the answer', async () => {
  const r = await api(drv.page, `/orders/${D.id}/handoff`);
  must([401, 403, 404].includes(r.status) && !r.body?.code, `got ${r.status}`);
});
await step(null, 'Driver', 'Reads the order itself, looking for the code', 'The order has no code in it', async () => {
  const r = await api(drv.page, `/orders/${D.id}`);
  must(r.status === 200 && !JSON.stringify(r.body).match(/"code"/), 'code leaked in the order');
});
await step(null, 'Driver', 'Marks it picked up without a photo', 'Refused (422) “take a photo of the items first”', async () => {
  const r = await api(drv.page, `/driver/orders/${D.id}/secured`, { method: 'POST', body: '{}' });
  must(r.status === 422, `got ${r.status}`);
});
await step(null, 'Driver', 'Skips straight to “delivered”', 'Refused — the order isn’t out for delivery', async () => {
  const r = await api(drv.page, `/driver/orders/${D.id}/delivered`, { method: 'POST', body: JSON.stringify({ code: '1234' }) });
  must(r.status === 409, `got ${r.status}`);
});
await drv.page.click(`#queue [data-id="${D.id}"]`);
await drv.page.setInputFiles('#pickPhoto', PHOTO);
await drv.page.waitForSelector('#pickCap.done');
await drv.page.click('#pickBtn');
await drv.page.waitForSelector('#codeIn', { state: 'visible' });
await step(null, 'Driver', 'After pickup, tries to swap the pickup photo for another one', 'Refused (409) — evidence is frozen once its step is done', async () => {
  const r = await drv.page.evaluate(async (id) => {
    const res = await fetch(`/api/driver/orders/${id}/pickup-proof`, { method: 'POST', headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${sessionStorage.getItem('driverToken')}` }, body: 'x' });
    return res.status;
  }, D.id);
  must(r === 409, `got ${r}`);
});
await step(null, 'Driver', 'Delivers “without a code” with no door photo', 'Refused (422) “take a photo at the door first”', async () => {
  const r = await api(drv.page, `/driver/orders/${D.id}/delivered`, { method: 'POST', body: JSON.stringify({ noCodeReason: 'phone dead' }) });
  must(r.status === 422, `got ${r.status}`);
});
await step(null, 'Driver', 'Guesses codes as fast as possible', 'Locked after 5 wrong tries (423); the photo path is the only way left', async () => {
  let last;
  for (let i = 0; i < 6; i += 1) {
    const guess = String(9000 + i);
    // eslint-disable-next-line no-await-in-loop
    last = await api(drv.page, `/driver/orders/${D.id}/delivered`, { method: 'POST', body: JSON.stringify({ code: guess }) });
    if (last.status === 200) throw new Error(`guess ${guess} delivered it`);
  }
  must(last.status === 423, `after 6 guesses got ${last.status}`);
});
const otherName = D.driver === 'Amina' ? 'Bashir' : 'Amina';
const other = await driverFor(otherName);
await step(null, 'Another driver', `${otherName} (not assigned) opens the order`, 'Not found (404) — drivers see only their own jobs', async () => {
  const r = await api(other.page, `/driver/orders/${D.id}`);
  must(r.status === 404, `got ${r.status}`);
});
await step(null, 'Another customer', 'Customer A tries to read customer D’s order and code', 'Not found (404)', async () => {
  const r1 = await api(cust.page, `/orders/${D.id}`);
  const r2 = await api(cust.page, `/orders/${D.id}/handoff`);
  must(r1.status === 404 && r2.status === 404, `got ${r1.status}/${r2.status}`);
});
await step(null, 'Operator', 'Calls the old “assign driver” API directly to hand the order to a friend', 'Gone (404) — dispatch is automatic, there is no way to choose', async () => {
  const r = await op.page.evaluate(async (id) => {
    const res = await fetch(`/api/operator/orders/${id}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('opToken')}` }, body: JSON.stringify({ driverId: 1 }) });
    return res.status;
  }, D.id);
  must(r === 404, `got ${r}`);
});
await step(null, 'Operator', 'Tries to confirm a payment without a transaction number', 'Refused (400) — every confirmation names a real payment', async () => {
  const r = await op.page.evaluate(async (id) => {
    const res = await fetch(`/api/operator/orders/${id}/mark-paid`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('opToken')}` }, body: '{}' });
    return res.status;
  }, B.id);
  must(r === 400 || r === 409, `got ${r}`);
});
await step(null, 'Operator', 'Tries to mark a refund as paid (ordinary operator, not an admin)', 'Refused (403) — only an admin records money going back', async () => {
  const r = await op.page.evaluate(async () => {
    const res = await fetch('/api/operator/refunds/1/settle', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('opToken')}` }, body: JSON.stringify({ reference: 'FAKE123' }) });
    return res.status;
  });
  must(r === 403, `got ${r}`);
});
await step(null, 'Customer', 'Disputes an order that was never delivered', 'Refused (409)', async () => {
  const r = await api(custD.page, `/orders/${D.id}/dispute`, { method: 'POST', body: '{}' });
  must(r.status === 409, `got ${r.status}`);
});

// ═══ E ═══
scenario('E2. The order fails after payment',
  'The market is out of stock. The driver stops the order with a reason; the customer was already paid up, so the office now owes them money.');
await drv.page.goto(BASE + '/driver/');
await drv.page.waitForSelector(`#queue [data-id="${D.id}"]`);
await drv.page.click(`#queue [data-id="${D.id}"]`);
await drv.page.click('#problemBox summary');
await drv.page.selectOption('#failReason', 'Items not available');
await step(drv.page, 'Driver', 'Taps “Report a problem”, picks “Items not available”, taps Stop twice', 'Order stopped', async () => {
  await drv.page.click('#failBtn');
  await drv.page.click('#failBtn');
  await drv.page.waitForSelector('#queueView', { state: 'visible', timeout: 10000 });
});
await step(custD.page, 'Customer', 'Sees the update', '“Cancelled”, with a note that they will be called about money owed', async () => {
  await waitText(custD.page.locator('#statusBadge'), /Cancelled/);
  await waitText(custD.page.locator('#statusSub'), /money owed/);
});
await section(op.page, 'refunds');
await step(op.page, 'Operator', 'Opens Refunds and selects the new one', 'The full total owed with the driver’s reason — and NO button to mark it paid: only an admin can', async () => {
  await waitText(op.page.locator('#refunds'), new RegExp(D.total.replace(/[$.]/g, '\\$&')));
  await op.page.locator('#refunds [data-open]', { hasText: D.total }).first().click();
  await waitText(op.page.locator('#refundDetail'), /Items not available/);
  await waitText(op.page.locator('#refundDetail'), /Only an admin/);
  must(await op.page.locator('#rfSettle').count() === 0, 'an ordinary operator can settle refunds');
});

// ═══ F ═══
scenario('F. A new driver joins (email only)',
  'Someone asks to drive. Their phone is a contact reference; the setup code goes to their email. An admin approves, creates the account, and the driver sets their own PIN.');
const applicant = await device('phone');
const appPhone = `65${stamp.slice(-6)}1`;
const appEmail = `driver-${stamp}@example.com`;
await applicant.page.goto(BASE + '/');
await applicant.page.click('#joinBtn');
await step(applicant.page, 'Applicant', 'Opens “Ask to join” and fills in name, phone (reference) and email', 'Email is required — it is where the setup code will go', async () => {
  await applicant.page.fill('#joinName', 'Sim Applicant');
  await applicant.page.fill('#joinPhone', appPhone);
  await applicant.page.click('#joinSubmit');
  await waitText(applicant.page.locator('.toast'), /email/i);
  await applicant.page.fill('#joinEmail', appEmail);
});
await step(applicant.page, 'Applicant', 'Sends the request', '“Request sent” — no account exists yet', async () => {
  await applicant.page.click('#joinSubmit');
  await waitText(applicant.page.locator('#joinStatus'), /Request sent/);
});
const adm = await device('desk');
await adm.page.goto(BASE + '/operator/');
await adm.page.fill('#username', 'admin');
await adm.page.fill('#password', 'change-me-please-1');
await adm.page.click('#loginBtn');
await adm.page.waitForSelector('#orders', { state: 'visible' });
await section(adm.page, 'team');
await step(adm.page, 'Admin', 'Opens Team and selects the request', 'BLIND review: name and ID only — phone and email hidden until a decision', async () => {
  await adm.page.locator('#accessRequests [data-open]', { hasText: 'Sim Applicant' }).first().click();
  await waitText(adm.page.locator('#teamDetail'), /Blind review/);
  const txt = await adm.page.textContent('#teamDetail');
  must(!txt.includes(appEmail) && !txt.includes(appPhone), 'contact details visible before the decision');
});
await step(adm.page, 'Admin', 'Approves, then creates the account', 'Setup code emailed to the applicant (on staging the code is shown instead)', async () => {
  await adm.page.click('#teamDetail [data-status="approved"]');
  await adm.page.waitForSelector('#reqAcct');
  must((await adm.page.inputValue('#reqEmail')) === appEmail, 'email not pre-filled');
  await adm.page.click('#reqAcct');
  await waitText(adm.page.locator('.toast'), /\d{8}/);
});
const setupCode = ((await adm.page.textContent('.toast')) || '').match(/\d{8}/)?.[0];
await applicant.page.goto(BASE + '/driver/');
await applicant.page.click('#showSetup');
await step(applicant.page, 'New driver', 'Enters phone, the emailed code, and a new 6-digit PIN', 'Signed in to an empty job list', async () => {
  await applicant.page.fill('#sPhone', appPhone);
  await applicant.page.fill('#sCode', setupCode || '');
  await applicant.page.fill('#sPin', '482913');
  await applicant.page.fill('#sPin2', '482913');
  await applicant.page.click('#setupBtn');
  await applicant.page.waitForSelector('#queueView', { state: 'visible' });
});
await section(adm.page, 'drivers');
await step(adm.page, 'Admin', 'Opens Drivers', 'The new driver is on the roster; dispatch can now give them orders', async () => {
  await waitText(adm.page.locator('#drivers'), /Sim Applicant/);
});
await section(adm.page, 'refunds');
await step(adm.page, 'Admin', `Sends the ${D.total} back from the business phone, then records the reference`, 'Refund recorded; it moves to “Recently closed”', async () => {
  await adm.page.locator('#refunds [data-open]', { hasText: D.total }).first().click();
  await adm.page.fill('#rfRef', `RF${stamp}`);
  await adm.page.click('#rfSettle');
  await waitText(adm.page.locator('.toast'), /Refund recorded/);
});
await section(adm.page, 'audit');
await step(adm.page, 'Admin', 'Opens the Audit log', 'Every decision today is there — payments, automatic dispatches, the review, the new account — and cannot be edited', async () => {
  const log = adm.page.locator('#auditList');
  await waitText(log, /Payment confirmed/);
  await waitText(log, /Order dispatched/);
  await waitText(log, /Access request decided/);
  await waitText(log, /Staff account created/);
  await waitText(log, /Refund recorded as paid/);
});

await browser.close();

// ── Report ──
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const total = steps.filter((s) => s.who).length;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GuriKaabe simulation</title><style>
:root{--bg:#f5f4f0;--panel:#fff;--line:#e3e0d7;--text:#141414;--muted:#66666b;--ok:#0f9f6e;--bad:#d02f2f;--gold:#b88a00}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0c;--panel:#151517;--line:#2b2b30;--text:#f5f5f4;--muted:#9b9ba1;--ok:#34d399;--bad:#f05252;--gold:#d4af37}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{margin:0 0 4px}h2{margin:36px 0 4px;color:var(--gold)}
.sum{font-size:18px;font-weight:700;margin:8px 0 0}.sum.ok{color:var(--ok)}.sum.bad{color:var(--bad)}
.step{display:grid;grid-template-columns:1fr 300px;gap:16px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;margin:10px 0}
.step.noimg{grid-template-columns:1fr}.who{font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.did{font-weight:700;margin:2px 0}.exp{color:var(--muted)}.res{font-weight:800;margin-top:6px}.res.ok{color:var(--ok)}.res.bad{color:var(--bad)}
img{width:100%;border-radius:10px;border:1px solid var(--line)}p.intro{color:var(--muted);margin:0 0 8px;max-width:760px}
@media (max-width:700px){.step{grid-template-columns:1fr}}
</style></head><body><main>
<h1>GuriKaabe — end-to-end simulation</h1>
<p class="intro">Staging (${esc(BASE)}), ${new Date().toLocaleString()}. Real apps in a real browser: separate phones for each customer and driver, a desk for the operator. Customer sign-in runs email-only, as production does without SMS. Staging data only.</p>
<div class="sum ${failures ? 'bad' : 'ok'}">${failures ? `✗ ${failures} of ${total} steps failed` : `✓ All ${total} steps behaved as expected`}</div>
${steps.map((s) => s.scenario
    ? `<h2>${esc(s.scenario)}</h2><p class="intro">${esc(s.intro)}</p>`
    : `<div class="step${s.shot ? '' : ' noimg'}"><div><div class="who">${esc(s.who)}</div><div class="did">${esc(s.did)}</div>
       <div class="exp">Expected: ${esc(s.expect)}</div>
       <div class="res ${s.ok ? 'ok' : 'bad'}">${s.ok ? '✓ as expected' : `✗ ${esc(s.note)}`}</div></div>
       ${s.shot ? `<a href="${s.shot}"><img src="${s.shot}" alt=""></a>` : ''}</div>`).join('\n')}
</main></body></html>`;
await writeFile(join(OUT, 'report.html'), html);
console.log(`\n${failures ? `✗ ${failures} failed` : `✓ all ${total} steps passed`} — report: ${join(OUT, 'report.html')}`);
process.exit(failures ? 1 : 0);
