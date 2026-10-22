// The whole business in one test, across the three apps: a customer orders and pays, the
// operator confirms and dispatches, the driver delivers — and the customer's page follows
// every step live over the WebSocket.
import { test, expect } from '@playwright/test';
import { openApp, signInCustomer, signInOperator, signInDriver, somaliNumber, SEED } from './helpers.js';

test('order → pay → confirm → dispatch → deliver, live on the customer page', async ({ browser }, testInfo) => {
  const customer = await openApp(browser, testInfo);
  await signInCustomer(customer, somaliNumber());

  // Place the order.
  await customer.fill('#request', 'Staging test: 2kg rice, cooking oil');
  await customer.fill('#amount', '7.50');
  await customer.fill('#landmark', 'Staging landmark — green gate by the pharmacy');
  await customer.click('#submitBtn');
  await expect(customer.locator('#orderView')).toBeVisible();
  const short = (await customer.locator('#orderId').textContent()).trim();
  const orderId = await customer.evaluate(() => JSON.parse(localStorage.getItem('gm_last')).orderId);

  // The wallet picker: one button per configured wallet, with the # still %23-encoded.
  const pay = customer.locator('#payWallets a');
  await expect(pay).toHaveCount(1);
  await expect(pay).toHaveText('Pay with EVC Plus');
  await expect(pay).toHaveAttribute('href', 'tel:*712*612345678*7.50%23');

  // "I've paid" is a hint for the operator, never a status change.
  const ref = `STG${Date.now().toString().slice(-6)}`;
  await customer.fill('#payRef', ref);
  await customer.click('#paidBtn');
  await expect(customer.locator('#paidNote')).toBeVisible();
  await expect(customer.locator('#statusBadge')).toHaveClass(/pending/);

  // Operator: the claim is at the top, names the wallet, and has the reference filled in.
  const operator = await openApp(browser, testInfo);
  await signInOperator(operator, SEED.dispatcher);
  const card = operator.locator('#orders .card', { hasText: `#${short}` });
  await expect(card).toContainText('Customer says they paid with EVC Plus');
  await expect(card.locator(`[data-payref="${orderId}"]`)).toHaveValue(ref);
  await card.locator(`[data-confirm="${orderId}"]`).click();

  // Paid shows up on the customer's page without a reload.
  await expect(customer.locator('#statusBadge')).toHaveClass(/paid/);

  // Dispatch to the seeded driver — once the card has redrawn as paid, so the picker we fill
  // in is the one that stays on screen.
  await expect(card).toContainText('PAID_UNASSIGNED');
  const assign = operator.locator(`select[data-assign="${orderId}"]`);
  const amina = await assign.locator('option', { hasText: SEED.driver.name }).getAttribute('value');
  await assign.selectOption(amina);
  await operator.locator(`[data-assignbtn="${orderId}"]`).click();
  await expect(operator.locator('.toast')).toContainText('Driver assigned');

  // Driver: only their assigned order, then secured → delivered.
  const driver = await openApp(browser, testInfo);
  await signInDriver(driver, SEED.driver);
  await driver.locator(`#queue [data-id="${orderId}"]`).click();
  await driver.locator('#actions [data-action="secured"]').click();
  await expect(customer.locator('#statusBadge')).toHaveText('On the way to you');
  await driver.locator('#actions [data-action="delivered"]').click();

  await expect(customer.locator('#statusBadge')).toHaveText('Delivered');
  // Once paid, there is nothing left to pay.
  await expect(customer.locator('#payWallets')).toBeHidden();
});
