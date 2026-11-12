// Shared steps for the staging workflows. Staging runs OTP_TRANSPORT=log, so every code shows
// on screen ("Dev mode — your code is 123456") and the tests read it from there — the same
// thing a person clicking through staging sees.
import { expect } from '@playwright/test';

export const SEED = {
  admin: { username: 'admin', password: 'change-me-please-1' },
  dispatcher: { username: 'hodan', password: 'seeded-operator-pw-1' },
  driver: { msisdn: '619876543', pin: '1234', name: 'Amina' },
  // Dispatch is automatic: tests sign in as whichever driver the system chose.
  drivers: {
    Amina: { msisdn: '619876543', pin: '1234', name: 'Amina' },
    Bashir: { msisdn: '651112223', pin: '5678', name: 'Bashir' },
    Cali: { msisdn: '631234567', pin: '2468', name: 'Cali' },
  },
};

// Dispatch only picks drivers who are ONLINE (the seed starts them offline, like a shift that
// hasn't begun). Put the delivery drivers on, with a fresh position, over the API.
export async function driversOnline(request, names = ['Amina', 'Bashir'], at = { lat: 2.0469, lng: 45.3182 }) {
  for (const name of names) {
    const d = SEED.drivers[name];
    // eslint-disable-next-line no-await-in-loop
    const login = await request.post('/api/driver/login', { data: { msisdn: `+252${d.msisdn}`, pin: d.pin } });
    // eslint-disable-next-line no-await-in-loop
    const { token } = await login.json();
    const headers = { Authorization: `Bearer ${token}` };
    // eslint-disable-next-line no-await-in-loop
    await request.post('/api/driver/online', { headers, data: { online: true } });
    // eslint-disable-next-line no-await-in-loop
    await request.post('/api/driver/location', { headers, data: { ...at, accuracy: 15 } });
  }
}

// A customer's phone with location on, at a door in Mogadishu.
export const CUSTOMER_PHONE = { permissions: ['geolocation'], geolocation: { latitude: 2.0390, longitude: 45.3260 } };

// Shop: add the first `n` items of the first category, open the cart, set the door by GPS,
// and place the order. Returns { orderId, total }.
export async function placeDelivery(page, { n = 2, custom = null, landmark = 'Staging landmark — green gate', photo = null, phone = null } = {}) {
  await page.click('#goShop');
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await page.locator('#catItems .step-add').first().click();
  }
  // Nothing from the catalog: the way in is the "Something else?" tile (the cart bar is hidden).
  await page.click(n > 0 ? '#cartOpen' : '#shopCustom');
  await expect(page.locator('#startView')).toBeVisible();
  if (custom) {
    if (!(await page.locator('#customBox').evaluate((d) => d.open))) await page.locator('#customBox summary').click();
    await page.fill('#request', custom.text);
    await page.fill('#budget', String(custom.budget));
    if (photo) await page.setInputFiles('#refPhoto', photo);
  }
  await page.click('#locBtn');
  await expect(page.locator('#locStatus')).toContainText('±');
  await page.fill('#landmark', landmark);
  if (phone) await page.fill('#orderPhone', phone);
  await expect(page.locator('#qTotal')).toHaveText(/^\d+\.\d{2}$/);
  const total = (await page.locator('#qTotal').textContent()).trim();
  await page.click('#submitBtn');
  await expect(page.locator('#orderView')).toBeVisible();
  const orderId = await page.evaluate(() => JSON.parse(localStorage.getItem('gm_last')).orderId);
  return { orderId, total };
}

const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
// Fresh numbers per run, so per-number rate limits and cooldowns never carry over.
export const somaliNumber = (prefix = '61') => prefix + digits(7);
// A driver's phone with location on, somewhere in Mogadishu.
export const DRIVER_PHONE = { permissions: ['geolocation'], geolocation: { latitude: 2.0469, longitude: 45.3182 } };

export const usNumber = () => '2065' + digits(6);

// Each app gets its own browser context: separate storage, like separate handsets.
// `extra` passes context options through — a driver gets a GPS fix, like a real phone.
export async function openApp(browser, testInfo, extra = {}) {
  const { baseURL, ignoreHTTPSErrors } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors, locale: 'en-US', ...extra });
  // English, whatever the machine's language: the assertions read English text.
  await context.addInitScript(() => { try { localStorage.setItem('gm_lang', 'en'); } catch {} });
  return context.newPage();
}

// Wait for a 6- or 8-digit dev code to appear in `locator`, and return it.
export async function codeIn(locator, length = 6) {
  const re = new RegExp(`\\b(\\d{${length}})\\b`);
  await expect(locator).toHaveText(re);
  return (await locator.textContent()).match(re)[1];
}

// Customer sign-in by text. `country` picks the +252 / +1 switch.
export async function signInCustomer(page, national, country = 'SO') {
  await page.goto('/');
  await page.locator('#asCustomer').click();
  await page.click('#useCode'); // the code flow sits behind the password form
  await page.locator('#authView .phone-field .cc-switch button', { hasText: country === 'US' ? '+1' : '+252' }).click();
  await page.fill('#phone', national);
  await page.click('#sendCodeBtn');
  const code = await codeIn(page.locator('#otpStatus'));
  await page.fill('#codeInput', code);
  await page.click('#verifyBtn');
  await expect(page.locator('#homeView')).toBeVisible();
}

export async function signInOperator(page, { username, password }) {
  await page.goto('/operator/');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#loginBtn');
  await expect(page.locator('#orders')).toBeVisible();
}

export async function signInDriver(page, { msisdn, pin }) {
  await page.goto('/driver/');
  await page.fill('#msisdn', msisdn);
  await page.fill('#pin', pin);
  await page.click('#loginBtn');
  await expect(page.locator('#queueView')).toBeVisible();
}

// Operator console sections: a sidebar on a desk, pills on a phone — click whichever shows.
export async function goSection(page, id) {
  await page.locator(`[data-nav="${id}"]:visible`).first().click();
}

// After payment the SYSTEM assigns a driver; read who from the operator's order panel.
export async function assignedDriver(operator) {
  const panel = operator.locator('#orderDetail');
  await expect(panel).toContainText('assigned automatically');
  const name = (await panel.textContent()).match(/🛵 (\w+)/)[1];
  return SEED.drivers[name];
}

// Earlier tests can leave a driver busy (dispatch is automatic). Stop their active jobs from
// the desk, so a test that needs that driver free doesn't depend on test order.
export async function freeDriver(request, name) {
  const login = await request.post('/api/operator/login', { data: SEED.admin });
  const { token } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };
  const { orders = [] } = await (await request.get('/api/operator/orders', { headers })).json();
  for (const o of orders.filter((x) => x.driver_name === name && ['DISPATCHED', 'IN_TRANSIT'].includes(x.status))) {
    // eslint-disable-next-line no-await-in-loop
    await request.post(`/api/operator/orders/${o.id}/refund`, { headers, data: { reason: 'test setup' } });
  }
}
