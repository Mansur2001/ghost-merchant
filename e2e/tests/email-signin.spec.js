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

  // Sign out, then back in with just the email: the switch swaps the phone box for an email box.
  await page.click('#signOutBtn');
  await page.goto('/');
  await page.getByRole('button', { name: /I'm a customer/ }).click();
  await page.locator('#channelPick [data-channel="email"]').click();
  await expect(page.locator('#phone')).toBeHidden();
  await expect(page.locator('#signinEmail')).toBeVisible();
  await expect(page.locator('#sendCodeBtn')).toHaveText('Email me a code');
  await page.fill('#signinEmail', email.toUpperCase());

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
  // Same account as the phone sign-in: the email only found it.
  await expect(page.locator('#signedInAs')).toContainText(number.replace(/\D/g, '').slice(-4));
});

test('the Phone | Email switch swaps the box, both ways', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo);
  await page.goto('/');
  await page.getByRole('button', { name: /I'm a customer/ }).click();
  await expect(page.locator('#phone')).toBeVisible();
  await expect(page.locator('#signinEmail')).toBeHidden();
  await page.locator('#channelPick [data-channel="email"]').click();
  await expect(page.locator('#signinEmail')).toBeVisible();
  await expect(page.locator('#consentNote')).toContainText('We email you');
  await page.locator('#channelPick [data-channel="sms"]').click();
  await expect(page.locator('#phone')).toBeVisible();
  await expect(page.locator('#signinEmail')).toBeHidden();
  await expect(page.locator('#sendCodeBtn')).toHaveText('Text me a code');
});

test('"Email me a code" for an email with no account looks exactly like a send', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo);
  await page.goto('/');
  await page.getByRole('button', { name: /I'm a customer/ }).click();
  await page.locator('#channelPick [data-channel="email"]').click();
  await page.fill('#signinEmail', `nobody-${Date.now()}@example.com`);
  await page.click('#sendCodeBtn');
  // The "if" wording, and no code: nothing was sent, and nothing says so.
  await expect(page.locator('#otpStatus')).toContainText('If this email is on an account');
  await expect(page.locator('#otpStatus')).not.toHaveText(/\d{6}/);
});
