// The customer wallet in the app (staging has WALLET_ENABLED=true and the WaafiPay simulator):
// top up with a prompt on the phone, then pay an order from the balance in one tap.
import { test, expect } from '@playwright/test';
import { openApp, signInCustomer, somaliNumber, CUSTOMER_PHONE, placeDelivery } from './helpers.js';

test('top up the wallet, then pay an order from it', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo, CUSTOMER_PHONE);
  await signInCustomer(page, somaliNumber());
  await page.click('.tabbar [data-tab="wallet"]');
  await expect(page.locator('#walletView')).toBeVisible();
  await expect(page.locator('#walletBalance')).toHaveText('0.00');
  await page.click('#walletTopupBtn');
  await page.fill('#topupAmount', '25');
  await page.fill('#topupPhone', '901234567');
  await page.locator('#topupButtons button', { hasText: 'Sahal' }).click();
  await expect(page.locator('#topupStatus')).toContainText('enter your PIN');
  await expect(page.locator('#walletBalance')).toHaveText('25.00', { timeout: 15000 });
  await expect(page.locator('#walletHistory')).toContainText('Added');

  await page.click('.tabbar [data-tab="home"]');
  const { total } = await placeDelivery(page, { n: 2 });
  await expect(page.locator('#walletPayBtn')).toContainText(`Pay $${total} from wallet`);
  await page.click('#walletPayBtn');
  await expect(page.locator('#statusBadge')).not.toHaveText('Awaiting payment');
  await page.click('.tabbar [data-tab="wallet"]');
  await expect(page.locator('#walletBalance')).toHaveText((25 - Number(total)).toFixed(2));
  await expect(page.locator('#walletHistory')).toContainText('Paid an order');
});
