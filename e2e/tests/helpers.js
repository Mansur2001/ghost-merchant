// Shared steps for the staging workflows. Staging runs OTP_TRANSPORT=log, so every code shows
// on screen ("Dev mode — your code is 123456") and the tests read it from there — the same
// thing a person clicking through staging sees.
import { expect } from '@playwright/test';

export const SEED = {
  admin: { username: 'admin', password: 'change-me-please-1' },
  dispatcher: { username: 'hodan', password: 'seeded-operator-pw-1' },
  driver: { msisdn: '619876543', pin: '1234', name: 'Amina' },
};

const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
// Fresh numbers per run, so per-number rate limits and cooldowns never carry over.
export const somaliNumber = (prefix = '61') => prefix + digits(7);
export const usNumber = () => '2065' + digits(6);

// Each app gets its own browser context: separate storage, like separate handsets.
export async function openApp(browser, testInfo) {
  const { baseURL, ignoreHTTPSErrors } = testInfo.project.use;
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors, locale: 'en-US' });
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
  await page.getByRole('button', { name: /I'm a customer/ }).click();
  await page.locator('#authView .phone-field .cc-switch button', { hasText: country === 'US' ? '+1' : '+252' }).click();
  await page.fill('#phone', national);
  await page.click('#sendCodeBtn');
  const code = await codeIn(page.locator('#otpStatus'));
  await page.fill('#codeInput', code);
  await page.click('#verifyBtn');
  await expect(page.locator('#startView')).toBeVisible();
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
