// Email codes: confirm an email while signed in, then sign in with "Email me a code".
import { test, expect } from '@playwright/test';
import { openApp, signInCustomer, codeIn, usNumber } from './helpers.js';

test('link an email, then sign in by email', async ({ browser }, testInfo) => {
  // Signing in consumes the code (and with it the 60s resend cooldown), so the email request
  // normally goes straight through; the wait below only matters if a send is still cooling down.
  test.setTimeout(150_000);
  const page = await openApp(browser, testInfo);
  const number = usNumber();
  await signInCustomer(page, number, 'US');

  // Add and confirm an email.
  const email = `staging-${Date.now()}@example.com`;
  await page.locator('#emailBox summary').click();
  await page.fill('#emailInput', email);
  await page.click('#emailSend');
  const linkCode = await codeIn(page.locator('#emailStatus'));

  // A wrong code is an error message, not a sign-out (the server answers 400, not 401).
  await page.fill('#emailCode', linkCode === '000000' ? '111111' : '000000');
  await page.click('#emailVerify');
  await expect(page.locator('#emailStatus')).not.toHaveText(/\d{6}/);
  await expect(page.locator('#startView')).toBeVisible();

  await page.fill('#emailCode', linkCode);
  await page.click('#emailVerify');
  await expect(page.locator('#emailCurrent')).toContainText(email);

  // Sign out, then back in by email.
  await page.click('#signOutBtn');
  await page.goto('/');
  await page.getByRole('button', { name: /I'm a customer/ }).click();
  await page.locator('#authView .phone-field .cc-switch button', { hasText: '+1' }).click();
  await page.fill('#phone', number);
  await page.locator('#channelPick [data-channel="email"]').click();
  await expect(page.locator('#sendCodeBtn')).toHaveText('Email me a code');

  // If a code is still cooling down, wait it out as a person would.
  await page.click('#sendCodeBtn');
  const status = page.locator('#otpStatus');
  await expect(status).toHaveText(/\d/);
  const wait = (await status.textContent()).match(/again in (\d+)s/);
  if (wait) {
    await page.waitForTimeout((Number(wait[1]) + 1) * 1000);
    await page.click('#sendCodeBtn');
  }
  await page.fill('#codeInput', await codeIn(status));
  await page.click('#verifyBtn');
  await expect(page.locator('#startView')).toBeVisible();
});

test('"Email me a code" for a number with no email looks exactly like a send', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo);
  await page.goto('/');
  await page.getByRole('button', { name: /I'm a customer/ }).click();
  await page.locator('#authView .phone-field .cc-switch button', { hasText: '+1' }).click();
  await page.fill('#phone', usNumber());
  await page.locator('#channelPick [data-channel="email"]').click();
  await page.click('#sendCodeBtn');
  // The "if" wording, and no code: nothing was sent, and nothing says so.
  await expect(page.locator('#otpStatus')).toContainText('If this number has an email for codes');
  await expect(page.locator('#otpStatus')).not.toHaveText(/\d{6}/);
});
