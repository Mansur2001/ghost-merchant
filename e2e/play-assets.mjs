// Play Store graphics from staging seed data: phone, 7" and 10" tablet screenshots (each a real
// screen of the app, framed with a one-line caption) plus the 1024×500 feature graphic and the
// 512×512 icon. Run with `./scripts/staging.sh shots`, which reseeds staging first.
//
// Seed data only (CLAUDE.md): the numbers, names and orders on screen are the public fixtures.
import { chromium, request } from '@playwright/test';
import { mkdir, readFile, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'play-screenshots');
const BASE = process.env.STAGING_URL || 'https://localhost:8444';

// Final sizes are exact 9:16, inside Play's limits (phone/7": 320–3840 px; 10": 1080–7680 px).
// `app` is the CSS viewport the app is rendered at, so tablets get the tablet layout.
const DEVICES = {
  phone: { size: [1080, 1920], app: { width: 390, height: 844, scale: 3, mobile: true } },
  'tablet-7in': { size: [1206, 2144], app: { width: 600, height: 600, scale: 2, mobile: true } },
  'tablet-10in': { size: [1620, 2880], app: { width: 720, height: 600, scale: 2.25, mobile: true } },
};

// The story, in order. Captions are short: Play shows them as thumbnails.
const SCREENS = [
  { file: '01-home', title: 'Your market, at your door', sub: 'Groceries and errands across the city', go: home },
  { file: '02-order', title: 'Say what you need', sub: 'In your own words, with the nearest landmark', go: orderForm },
  { file: '03-pay', title: 'Pay from your own phone', sub: 'Your mobile money goes straight to the shop', go: pay },
  { file: '04-live', title: 'Follow it live', sub: 'Paid, on the way, delivered — step by step', go: live },
  { file: '05-chat', title: 'Talk to your driver', sub: 'Every order has its own chat', go: chat },
  { file: '06-delivered', title: 'A photo when it arrives', sub: 'So you know exactly what came', go: delivered },
  { file: '07-sign-in', title: 'Sign in with a code', sub: 'By text or by email — no password', go: signIn },
  { file: '08-somali', title: 'Af-Soomaali ama English', sub: 'Choose your language with one tap', go: somali },
];

const api = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
async function call(method, url, body, token) {
  const res = await api.fetch(`/api${url}`, {
    method,
    data: body,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const json = await res.json();
  if (!res.ok()) throw new Error(`${method} ${url} -> ${res.status()} ${JSON.stringify(json)}`);
  return json;
}
async function customerToken(phone) {
  const { devCode } = await call('POST', '/auth/otp/request', { phone });
  if (!devCode) throw new Error('staging must run OTP_TRANSPORT=log (no dev code came back)');
  return (await call('POST', '/auth/otp/verify', { phone, code: devCode })).token;
}

// Seeded customers: +252612345678 has the pending and the on-the-way orders, +252651234567 the
// delivered one.
const custA = { phone: '+252612345678', token: await customerToken('+252612345678') };
const custB = { phone: '+252651234567', token: await customerToken('+252651234567') };
const mine = async (c) => (await call('GET', '/orders/mine', undefined, c.token)).orders;
const custAOrders = await mine(custA);
const onTheWay = custAOrders.find((o) => o.status === 'IN_TRANSIT');
const done = (await mine(custB)).find((o) => o.status === 'DELIVERED');
if (!onTheWay || !done) throw new Error('staging is not on the seed data — run ./scripts/staging.sh seed');

// A short, ordinary conversation on the order that's on its way.
const driver = await call('POST', '/driver/login', { msisdn: '+252619876543', pin: '1234' });
const say = (token, text) => call('POST', `/orders/${onTheWay.id}/messages`, { body: text, clientId: crypto.randomUUID() }, token);
await say(custA.token, 'Salaan! The gate is green, 2nd floor.');
await say(driver.token, 'Got it. I have the flour and oil, 10 minutes away.');
await say(custA.token, 'Mahadsanid 🙏');

// The seeded proof photo is a flat placeholder; give the delivered order an illustration that
// reads as "your bag at your door". Drawn here, uploaded the way the driver app does.
async function proofIllustration(browser) {
  const page = await browser.newPage({ viewport: { width: 720, height: 720 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0}html,body{width:720px;height:720px;overflow:hidden}
  body{background:linear-gradient(#e9dcc4 0 62%,#b9a68a 62% 100%);position:relative;font-family:sans-serif}
  .door{position:absolute;left:230px;top:70px;width:260px;height:400px;background:#2f7d4f;border:14px solid #f3ead8;border-bottom:0;border-radius:8px 8px 0 0}
  .door:after{content:'';position:absolute;right:26px;top:190px;width:18px;height:18px;border-radius:50%;background:#d4af37}
  .mat{position:absolute;left:200px;top:470px;width:320px;height:40px;background:#7a5d3a;border-radius:6px}
  .bag{position:absolute;left:260px;top:330px;font-size:190px;line-height:1}
  .items{position:absolute;left:150px;top:520px;font-size:90px;letter-spacing:12px}
  </style></head><body><div class="door"></div><div class="mat"></div><div class="bag">🛍️</div><div class="items">🍞🧈🍓</div></body></html>`);
  const png = await page.screenshot({ type: 'png' });
  await page.close();
  return png;
}

// A fresh unpaid order (the seeded one already says "I've paid"), placed the way the app does.
const pending = (await call('POST', '/orders', {
  id: crypto.randomUUID(),
  phone: custA.phone,
  items: [{ text: '2kg rice, 1L cooking oil, 6 eggs, bananas' }],
  totalAmount: 8.5,
  lat: null,
  lng: null,
  landmark: 'Green house next to the yellow pharmacy',
}, custA.token)).order;
await call('POST', `/orders/${pending.id}/messages`, { body: '2kg rice, 1L cooking oil, 6 eggs, bananas' }, custA.token);

// ── The screens ──
async function home(page) {
  await page.goto('/');
}
async function orderForm(page) {
  await page.goto('/');
  await page.click('#asCustomer');
  await page.fill('#request', '2kg rice, 1L cooking oil, 6 eggs, bananas');
  await page.fill('#amount', '8.50');
  await page.fill('#landmark', 'Green house next to the yellow pharmacy');
}
orderForm.after = (page) => scrollTo(page, 'label[for="request"]');
async function openOrder(page, id) {
  await page.goto('/');
  await page.evaluate((orderId) => localStorage.setItem('gm_last', JSON.stringify({ orderId })), id);
  await page.reload();
  await page.locator('#orderView').waitFor();
}
async function pay(page) {
  await openOrder(page, pending.id);
  await page.locator('#payWallets a').first().waitFor();
}
async function live(page) {
  await openOrder(page, onTheWay.id);
  await page.locator('#timeline li').first().waitFor();
}
async function chat(page) {
  await openOrder(page, onTheWay.id);
  await page.locator('#thread .msg').nth(2).waitFor();
}
chat.after = (page) => scrollTo(page, 'h3[data-i18n="order.chat"]');
async function delivered(page) {
  await page.goto('/');
  await page.click('#asCustomer');
  await page.click('#resumeBtn');
  await page.locator(`#resumeList [data-id="${done.id}"]`).click();
  await page.locator('#photos img').first().waitFor();
}
delivered.after = (page) => scrollTo(page, 'h3[data-i18n="order.photos"]');
async function scrollTo(page, selector) {
  await page.locator(selector).evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 24));
}
async function signIn(page) {
  await page.goto('/');
  await page.click('#asCustomer');
  await page.fill('#phone', '612345678');
  await page.locator('#phone').blur();
}
async function somali(page) {
  await page.goto('/');
}

// Each screen is its own browser context: its own storage, like its own handset.
async function capture(browser, device, screen) {
  const { app } = DEVICES[device];
  const signedIn = !['01-home', '07-sign-in', '08-somali'].includes(screen.file);
  const who = screen.file === '06-delivered' ? custB : custA;
  const context = await browser.newContext({
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    viewport: { width: app.width, height: app.height },
    deviceScaleFactor: app.scale,
    isMobile: app.mobile,
    hasTouch: true,
    locale: 'en-US',
  });
  await context.addInitScript(({ lang, session }) => {
    localStorage.setItem('gm_lang', lang);
    localStorage.setItem('gm_theme', 'dark');
    if (session) { localStorage.setItem('gm_token', session.token); localStorage.setItem('gm_phone', session.phone); }
  }, { lang: screen.file === '08-somali' ? 'so' : 'en', session: signedIn ? who : null });
  const page = await context.newPage();
  await screen.go(page);
  await page.waitForLoadState('networkidle');
  // No caret, no toasts or hover states caught mid-animation.
  await page.addStyleTag({ content: '*{caret-color:transparent!important;transition:none!important;animation:none!important}.toast{display:none!important}' });
  await page.evaluate(() => document.activeElement?.blur());
  if (screen.go.after) await screen.go.after(page);
  await page.waitForTimeout(250);
  // Tablets: the whole page, so the device can be sized to what's on it rather than showing
  // a tall empty screen under a short order.
  const png = await page.screenshot({ fullPage: device !== 'phone' });
  await context.close();
  return png;
}

// The frame: caption on top, the real screen below in a phone/tablet body that runs off the
// bottom edge. Rendered as HTML so the type is crisp at every size.
function frameHtml({ width, height, title, sub, shot, tablet }) {
  const k = width / 1080;
  const bodyW = Math.round(width * (tablet ? 0.84 : 0.80));
  // A tablet is drawn whole (all four corners), centred under the caption, no taller than its
  // screen's content; a phone runs off the bottom edge.
  const tabletCss = tablet ? `.dev{flex:0 1 auto;border-radius:${Math.round(56 * k)}px;padding:${Math.round(22 * k)}px;margin:auto 0;
    max-height:calc(100% - ${Math.round(60 * k)}px);display:flex}
  .scr{border-radius:${Math.round(36 * k)}px;height:auto;overflow:hidden}
  .wrap{flex:1;display:flex;align-items:center;min-height:0;padding-bottom:${Math.round(60 * k)}px}` : '.wrap{flex:1;display:flex}';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  html,body{width:${width}px;height:${height}px;overflow:hidden}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:radial-gradient(120% 70% at 50% 0%,#fff6dc 0%,#f6e3a6 55%,#e9c766 100%);color:#1a1400;
    display:flex;flex-direction:column;align-items:center}
  .cap{padding:${Math.round(110 * k)}px ${Math.round(70 * k)}px ${Math.round(64 * k)}px;text-align:center}
  h1{font-size:${Math.round(84 * k)}px;line-height:1.08;font-weight:800;letter-spacing:-.02em}
  p{margin-top:${Math.round(22 * k)}px;font-size:${Math.round(40 * k)}px;line-height:1.3;color:#5b4a12;font-weight:500}
  .dev{width:${bodyW}px;flex:1;background:#0b0b0b;border-radius:${Math.round(78 * k)}px ${Math.round(78 * k)}px 0 0;
    padding:${Math.round(22 * k)}px ${Math.round(22 * k)}px 0;box-shadow:0 ${Math.round(30 * k)}px ${Math.round(80 * k)}px rgba(60,40,0,.35)}
  .scr{width:100%;height:100%;border-radius:${Math.round(58 * k)}px ${Math.round(58 * k)}px 0 0;overflow:hidden;background:#000}
  .scr img{width:100%;display:block}
  ${tabletCss}
  </style></head><body>
  <div class="cap"><h1>${title}</h1><p>${sub}</p></div>
  <div class="wrap"><div class="dev"><div class="scr"><img src="data:image/png;base64,${shot.toString('base64')}"></div></div></div>
  </body></html>`;
}

async function render(browser, html, [width, height], file) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: file, type: 'png' });
  await page.close();
}

// Feature graphic: brand left, a real screen on the right. Google may crop the edges and lay
// a play button over the middle on some surfaces, so the words stay left of centre.
async function featureGraphic(browser, shot) {
  const icon = (await readFile(path.join(ROOT, 'mobile/resources/play-store-icon-512.png'))).toString('base64');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  html,body{width:1024px;height:500px;overflow:hidden}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:radial-gradient(90% 120% at 15% 30%,#fff6dc 0%,#f6e3a6 55%,#e2bb4f 100%);color:#1a1400;position:relative}
  .brand{position:absolute;left:64px;top:84px;width:540px}
  .row{display:flex;align-items:center;gap:22px}
  .row img{width:118px;height:118px;border-radius:26px;box-shadow:0 10px 30px rgba(60,40,0,.25)}
  h1{font-size:64px;font-weight:800;letter-spacing:-.02em}
  .so{font-size:24px;font-weight:600;color:#7a5d00;margin-top:4px}
  p{margin-top:34px;font-size:32px;line-height:1.25;font-weight:700}
  .phone{position:absolute;right:74px;top:46px;width:270px;height:560px;background:#0b0b0b;border-radius:40px;padding:11px;
    box-shadow:0 24px 60px rgba(60,40,0,.4);transform:rotate(4deg)}
  .phone div{width:100%;height:100%;border-radius:30px;overflow:hidden}
  .phone img{width:100%;display:block}
  </style></head><body>
  <div class="brand">
    <div class="row"><img src="data:image/png;base64,${icon}"><div><h1>GuriKaabe</h1><div class="so">Adeeg kasta, Gurigaaga.</div></div></div>
    <p>Order from the market.<br>Pay from your phone.<br>Follow it to your door.</p>
  </div>
  <div class="phone"><div><img src="data:image/png;base64,${shot.toString('base64')}"></div></div>
  </body></html>`;
  await render(browser, html, [1024, 500], path.join(OUT, 'feature-graphic-1024x500.png'));
}

const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
try {
  const bashir = await call('POST', '/driver/login', { msisdn: '+252651112223', pin: '5678' });
  // Replaces the seed's SVG placeholder: one proof photo per order, whatever the format.
  const up = await api.post(`/api/driver/orders/${done.id}/delivery-proof`, {
    data: await proofIllustration(browser),
    headers: { Authorization: `Bearer ${bashir.token}`, 'Content-Type': 'image/png' },
  });
  if (!up.ok()) throw new Error(`proof upload -> ${up.status()} ${await up.text()}`);

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  let liveShot;
  for (const [device, spec] of Object.entries(DEVICES)) {
    await mkdir(path.join(OUT, device), { recursive: true });
    for (const screen of SCREENS) {
      const shot = await capture(browser, device, screen);
      if (device === 'phone' && screen.file === '04-live') liveShot = shot;
      const html = frameHtml({ width: spec.size[0], height: spec.size[1], title: screen.title, sub: screen.sub, shot, tablet: device !== 'phone' });
      await render(browser, html, spec.size, path.join(OUT, device, `${screen.file}.png`));
      console.log(`${device}/${screen.file}.png`);
    }
  }
  await featureGraphic(browser, liveShot);
  console.log('feature-graphic-1024x500.png');
  await copyFile(path.join(ROOT, 'mobile/resources/play-store-icon-512.png'), path.join(OUT, 'app-icon-512.png'));
  console.log('app-icon-512.png');
} finally {
  await browser.close();
  await api.dispose();
}
