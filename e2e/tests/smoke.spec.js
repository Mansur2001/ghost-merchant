// Fast checks that each app shell loads cleanly under the real CSP, and the small things that
// break quietly: flags, the Somali toggle, the legal pages.
import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

for (const path of ['/', '/driver/', '/operator/']) {
  test(`${path} loads with no console errors (CSP included)`, async ({ browser }, testInfo) => {
    const page = await openApp(browser, testInfo);
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  });
}

test('phone switch draws both flags', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo);
  await page.goto('/');
  await page.getByRole('button', { name: /I'm a customer/ }).click();
  const sw = page.locator('#authView .phone-field .cc-switch');
  await expect(sw.locator('button')).toHaveText(['+252', '+1']);
  await expect(sw.locator('svg')).toHaveCount(2);
});

test('Somali toggle switches the text', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo);
  await page.goto('/');
  await page.getByRole('button', { name: /I'm a customer/ }).click();
  await page.click('#langToggle');
  await expect(page.locator('#sendCodeBtn')).toHaveText('Koodh ii soo dir');
});

test('privacy policy and terms are real pages, not the app shell', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo);
  await page.goto('/privacy.html');
  await expect(page).toHaveTitle('GuriKaabe — Privacy Policy');
  await page.goto('/terms.html');
  await expect(page).toHaveTitle('GuriKaabe — Terms of Service');
});

test('every app shows the logo in the header', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo);
  for (const path of ['/', '/driver/', '/operator/']) {
    await page.goto(path);
    const logo = page.locator('header img[src="/icon-192.png"]');
    await expect(logo).toBeVisible();
    expect(await logo.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
  }
});
