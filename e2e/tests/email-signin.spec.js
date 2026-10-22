// Email codes: a sign-in of its own (new customers too), or an extra way into a phone account.
import { test, expect } from '@playwright/test';
import { openApp, signInCustomer, codeIn, usNumber, somaliNumber } from './helpers.js';

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

test('a new customer signs up with only an email, then orders with a phone for the driver', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo);
  await page.goto('/');
  await page.getByRole('button', { name: /I'm a customer/ }).click();
  await page.locator('#channelPick [data-channel="email"]').click();
  const email = `new-${Date.now()}@example.com`;
  await page.fill('#signinEmail', email);
  await page.click('#sendCodeBtn');
  await page.fill('#codeInput', await codeIn(page.locator('#otpStatus')));
  await page.click('#verifyBtn');
  await expect(page.locator('#signedInAs')).toHaveText(email);
  // Its only way in is this email: nothing to add or remove.
  await expect(page.locator('#emailBox')).toBeHidden();

  // No phone on the account, so the order asks for one.
  await page.fill('#request', 'Email-only staging order');
  await page.fill('#amount', '2');
  await page.fill('#landmark', 'Staging landmark');
  await page.click('#submitBtn');
  await expect(page.locator('#orderView')).toBeHidden();
  await page.fill('#orderPhone', somaliNumber());
  await page.click('#submitBtn');
  await expect(page.locator('#orderView')).toBeVisible();
});
