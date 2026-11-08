// The help chat answers from the FAQ (and a hosted model when a key is set — not on staging),
// in the customer's language, and "Talk to a person" goes to the order chat.
import { test, expect } from '@playwright/test';
import { openApp, signInCustomer, somaliNumber, CUSTOMER_PHONE, placeDelivery } from './helpers.js';

test('help chat answers from the FAQ, in Somali too, and hands an order to a person', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo, CUSTOMER_PHONE);
  await signInCustomer(page, somaliNumber());
  await page.click('.tabbar [data-tab="help"]');
  await expect(page.locator('#helpChat')).toBeVisible();
  await page.fill('#helpInput', 'How do I pay with Sahal?');
  await page.click('#helpSend');
  await expect(page.locator('#helpThread .msg').last()).toContainText('tap your wallet');

  await page.click('#langToggle');
  await page.fill('#helpInput', 'Darawalka xagee joogaa?');
  await page.click('#helpSend');
  await expect(page.locator('#helpThread .msg').last()).toContainText('khariidadda');
  await page.click('#langToggle');

  // From an order: the chat knows which one, and a person means the order's own chat.
  await page.click('.tabbar [data-tab="home"]');
  const { orderId } = await placeDelivery(page, { n: 1 });
  await page.click('#orderHelp');
  await expect(page.locator('#helpAbout')).not.toBeEmpty();
  await page.click('#helpHuman');
  await expect(page.locator('#orderView')).toBeVisible();
  await expect(page.locator('#chatInput')).toBeFocused();
});
