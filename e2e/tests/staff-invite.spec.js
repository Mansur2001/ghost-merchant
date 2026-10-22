// Staff onboarding by invite: an admin adds a driver (setup code by email), and the driver
// chooses their own PIN with it and lands in their queue.
import { test, expect } from '@playwright/test';
import { openApp, signInOperator, codeIn, somaliNumber, SEED } from './helpers.js';

test('admin invites a driver by email; the driver sets a PIN and signs in', async ({ browser }, testInfo) => {
  const admin = await openApp(browser, testInfo);
  await signInOperator(admin, SEED.admin);

  const name = `Staging Driver ${Date.now().toString().slice(-5)}`;
  const phone = somaliNumber('65');
  await admin.fill('#dName', name);
  await admin.fill('#dMsisdn', phone);
  await admin.fill('#dEmail', `driver-${Date.now()}@example.com`);
  await admin.click('#addDriver');
  // Dev mode shows the setup code in the toast instead of sending it.
  const code = await codeIn(admin.locator('.toast'), 8);
  await expect(admin.locator('#drivers')).toContainText(name);
  await expect(admin.locator('#drivers')).toContainText('Re-send setup code by email');

  const driver = await openApp(browser, testInfo);
  await driver.goto('/driver/');
  await driver.click('#showSetup');
  await driver.fill('#sPhone', phone);
  await driver.fill('#sCode', code);
  await driver.fill('#sPin', '482913');
  await driver.fill('#sPin2', '482913');
  await driver.click('#setupBtn');
  await expect(driver.locator('#queueView')).toBeVisible();
});
