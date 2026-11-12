// The help chat answers from the FAQ (and a hosted model when a key is set — not on staging),
// in the customer's language, and "Talk to a person" goes to the order chat.
import { test, expect } from '@playwright/test';
import { openApp, signInCustomer, somaliNumber, CUSTOMER_PHONE, placeDelivery } from './helpers.js';

test('help chat answers from the FAQ, in Somali too, and hands an order to a person', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo, CUSTOMER_PHONE);
  // Signed out: help is there before there is an account (on the landing and sign-in screens).
  await page.goto('/');
  await expect(page.locator('#chatLauncher')).toBeVisible();
  await page.click('#chatLauncher');
  await page.fill('#helpInput', 'How do I pay with Sahal?');
  await page.click('#helpSend');
  await expect(page.locator('#helpThread .msg').last()).toContainText('tap your wallet');
  await page.click('#chatMin');
  await page.click('#asCustomer');
  await expect(page.locator('#chatLauncher')).toBeVisible();

  await signInCustomer(page, somaliNumber());
  // The standard widget: a launcher in the corner opens the panel; the chevron collapses it.
  await expect(page.locator('#chatLauncher')).toBeVisible();
  await expect(page.locator('#chatPanel')).toBeHidden();
  await page.click('#chatLauncher');
  await expect(page.locator('#chatPanel')).toBeVisible();
  await expect(page.locator('#helpInput')).toBeFocused();
  await page.fill('#helpInput', 'How do I pay with Sahal?');
  await page.click('#helpSend');
  await expect(page.locator('#helpThread .msg').last()).toContainText('tap your wallet');

  await page.click('#chatMin');
  await expect(page.locator('#chatPanel')).toBeHidden();
  await expect(page.locator('#chatLauncher')).toHaveAttribute('aria-expanded', 'false');

  // The Help tab keeps the FAQ and opens the same chat; the conversation is still there.
  await page.click('.tabbar [data-tab="help"]');
  await page.click('#openChat');
  await expect(page.locator('#helpThread')).toContainText('tap your wallet');
  await page.click('#langToggle');
  await page.fill('#helpInput', 'Darawalka xagee joogaa?');
  await page.click('#helpSend');
  await expect(page.locator('#helpThread .msg').last()).toContainText('khariidadda');
  await page.click('#langToggle');
  await page.keyboard.press('Escape');
  await expect(page.locator('#chatPanel')).toBeHidden();

  // From an order: the chat knows which one, and a person means the order's own chat.
  await page.click('.tabbar [data-tab="home"]');
  // Screens with their own bottom button don't get the launcher over it.
  await page.click('#goRide');
  await expect(page.locator('#chatLauncher')).toBeHidden();
  await page.click('#rideBack');
  const { orderId } = await placeDelivery(page, { n: 1 });
  await expect(page.locator('#chatLauncher')).toBeVisible();
  await page.click('#orderHelp');
  await expect(page.locator('#helpAbout')).not.toBeEmpty();
  await page.click('#helpHuman');
  await expect(page.locator('#orderView')).toBeVisible();
  await expect(page.locator('#chatInput')).toBeFocused();
});
