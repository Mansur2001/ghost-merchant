// Email + password: signing in must not depend on an email arriving. And a password set on
// someone else's email must stop working the moment the real owner proves the address.
import { test, expect } from '@playwright/test';
import { openApp, codeIn } from './helpers.js';

const PASSWORD = 'market day 2026';

test('create an account with a password, sign out, sign back in — no email needed', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo);
  const email = `pw-${Date.now()}@example.com`;
  await page.goto('/');
  await page.locator('#asCustomer').click();
  await page.fill('#pwEmail', email);
  await page.fill('#pwPass', PASSWORD);
  await page.fill('#pwPass2', PASSWORD);
  await page.click('#pwBtn');
  await expect(page.locator('#startView')).toBeVisible();
  await expect(page.locator('#signedInAs')).toHaveText(email);

  await page.locator('.tabbar [data-tab="account"]').click();
  await expect(page.locator('#pwSetBox')).toBeVisible();
  await expect(page.locator('#pwSetTitle')).toHaveText('Change password');
  await page.click('#signOutBtn');

  await page.locator('#asSignin').click();
  await page.fill('#pwEmail', email);
  await page.fill('#pwPass', 'not the password');
  await page.click('#pwBtn');
  await expect(page.locator('#pwStatus')).toHaveText('Wrong email or password.');
  await page.fill('#pwPass', PASSWORD);
  await page.click('#pwBtn');
  await expect(page.locator('#startView')).toBeVisible();
});

test('a squatter\'s password dies when the real owner signs in with an emailed code', async ({ browser }, testInfo) => {
  test.setTimeout(150_000); // three phones, two sign-ups and a code: more than the default minute
  const email = `victim-${Date.now()}@example.com`;

  // Someone registers an email that isn't theirs.
  const squatter = await openApp(browser, testInfo);
  await squatter.goto('/');
  await squatter.locator('#asCustomer').click();
  await squatter.fill('#pwEmail', email);
  await squatter.fill('#pwPass', 'squatters secret 1');
  await squatter.fill('#pwPass2', 'squatters secret 1');
  await squatter.click('#pwBtn');
  await expect(squatter.locator('#startView')).toBeVisible();

  // The real owner: "Forgot your password?" -> emailed code -> lands on setting a new one.
  const owner = await openApp(browser, testInfo);
  await owner.goto('/');
  await owner.locator('#asSignin').click();
  await owner.fill('#pwEmail', email);
  await owner.click('#useCode');
  await expect(owner.locator('#signinEmail')).toHaveValue(email);
  await owner.click('#sendCodeBtn');
  await owner.fill('#codeInput', await codeIn(owner.locator('#otpStatus')));
  await owner.click('#verifyBtn');
  await expect(owner.locator('#accountView')).toBeVisible();
  await expect(owner.locator('#pwSetTitle')).toHaveText('Set a password'); // the squatter's is gone
  await expect(owner.locator('#pwCurrentWrap')).toBeHidden();
  await owner.fill('#pwNew', PASSWORD);
  await owner.fill('#pwNew2', PASSWORD);
  await owner.click('#pwSetBtn');
  await expect(owner.locator('.toast')).toContainText('Password saved');

  // The squatter's password no longer opens the account; the owner's does.
  const later = await openApp(browser, testInfo);
  await later.goto('/');
  await later.locator('#asSignin').click();
  await later.fill('#pwEmail', email);
  await later.fill('#pwPass', 'squatters secret 1');
  await later.click('#pwBtn');
  await expect(later.locator('#pwStatus')).toHaveText('Wrong email or password.');
  await later.fill('#pwPass', PASSWORD);
  await later.click('#pwBtn');
  await expect(later.locator('#startView')).toBeVisible();
});
