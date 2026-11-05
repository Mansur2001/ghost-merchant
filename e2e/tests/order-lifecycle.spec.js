// The whole business in one test, across the three apps: a customer orders and pays, the
// operator confirms and dispatches, the driver delivers — and the customer's page follows
// every step live over the WebSocket.
import { test, expect } from '@playwright/test';
import { openApp, signInCustomer, signInOperator, signInDriver, somaliNumber, SEED, DRIVER_PHONE, goSection, assignedDriver } from './helpers.js';

// A 1×1 PNG: the server checks a photo exists, not what's in it.
const photo = (name) => ({
  name,
  mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
});

test('order → pay → confirm → dispatch → pickup photo → customer code, live on the customer page', async ({ browser }, testInfo) => {
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
  // A list row per order; the work happens in the detail panel beside it.
  const card = operator.locator(`#orders [data-open="${orderId}"]`);
  await expect(card).toContainText('Customer says they paid with EVC Plus');
  await card.click();
  const detail = operator.locator('#orderDetail');
  await expect(detail.locator(`[data-payref="${orderId}"]`)).toHaveValue(ref);
  await detail.locator(`[data-confirm="${orderId}"]`).click();

  // Paid shows up on the customer's page without a reload.
  await expect(customer.locator('#statusBadge')).toHaveClass(/paid/);

  // Paid: the customer now has a delivery code, and only the customer sees it.
  await expect(customer.locator('#handoffCard')).toBeVisible();
  const code = (await customer.locator('#handoffCode').textContent()).trim();
  expect(code).toMatch(/^\d{4}$/);

  // Nobody picks the driver: the system assigns one the moment it's paid.
  await expect(card).toContainText('Driver at market');
  const chosen = await assignedDriver(operator);
  await expect(detail.locator('select')).toHaveCount(0);

  // Driver: only their assigned order. Pickup needs the photo of the items first.
  const driver = await openApp(browser, testInfo, DRIVER_PHONE);
  await signInDriver(driver, chosen);
  await driver.locator(`#queue [data-id="${orderId}"]`).click();
  await expect(driver.locator('#pickBtn')).toBeDisabled();
  await driver.setInputFiles('#pickPhoto', photo('items.png'));
  await expect(driver.locator('#pickCap')).toHaveClass(/done/);
  await driver.locator('#pickBtn').click();
  await expect(customer.locator('#statusBadge')).toHaveText('On the way to you');
  await expect(customer.locator('#proofList')).toContainText('photographed your items');

  // Delivery needs the customer's code. A wrong one is refused and counted.
  const wrong = code === '0000' ? '1111' : '0000';
  await driver.fill('#codeIn', wrong);
  await driver.locator('#deliverBtn').click();
  await expect(driver.locator('#codeMsg')).toContainText('4 tries left');
  await expect(customer.locator('#statusBadge')).toHaveText('On the way to you');

  await driver.fill('#codeIn', code);
  await driver.locator('#deliverBtn').click();
  await expect(customer.locator('#statusBadge')).toHaveText('Delivered');
  await expect(customer.locator('#proofList')).toContainText('Delivered with your code');
  // Once paid, there is nothing left to pay, and a used code is gone.
  await expect(customer.locator('#payWallets')).toBeHidden();
  await expect(customer.locator('#handoffCard')).toBeHidden();

  // The operator sees it as proven, with nothing to check.
  await goSection(operator, 'deliveries');
  const deliveredRow = operator.locator(`#deliveries [data-open="${orderId}"]`);
  await expect(deliveredRow).toContainText('Proven');
  await deliveredRow.click();
  const delivered = operator.locator('#deliveryDetail');
  await expect(delivered).toContainText('Customer gave the code');

  // The customer's own check: "I didn't get my order" puts it back in front of an operator.
  await customer.locator('#disputeBtn').click();
  await customer.locator('#disputeBtn').click();
  await expect(customer.locator('#disputeNote')).toBeVisible();
  // It reaches the desk live, without a reload.
  await expect(delivered).toContainText('Customer says not received');
  await expect(deliveredRow).toContainText('Check');
});

test('a delivery without the code needs a door photo and a reason, and waits for an operator', async ({ browser }, testInfo) => {
  const customer = await openApp(browser, testInfo);
  await signInCustomer(customer, somaliNumber());
  await customer.fill('#request', 'Staging: no-code delivery');
  await customer.fill('#amount', '3');
  await customer.fill('#landmark', 'Staging landmark — blue door');
  await customer.click('#submitBtn');
  await expect(customer.locator('#orderView')).toBeVisible();
  const short = (await customer.locator('#orderId').textContent()).trim();
  const orderId = await customer.evaluate(() => JSON.parse(localStorage.getItem('gm_last')).orderId);

  const operator = await openApp(browser, testInfo);
  await signInOperator(operator, SEED.dispatcher);
  const card = operator.locator(`#orders [data-open="${orderId}"]`);
  await card.click();
  await operator.fill(`[data-payref="${orderId}"]`, `NC${Date.now().toString().slice(-7)}`);
  await operator.locator(`[data-confirm="${orderId}"]`).click();
  await expect(card).toContainText('Driver at market');
  const chosen = await assignedDriver(operator);

  const driver = await openApp(browser, testInfo, DRIVER_PHONE);
  await signInDriver(driver, chosen);
  await driver.locator(`#queue [data-id="${orderId}"]`).click();
  await driver.setInputFiles('#pickPhoto', photo('items.png'));
  await expect(driver.locator('#pickBtn')).toBeEnabled();
  await driver.locator('#pickBtn').click();

  await driver.locator('#noCodeBox summary').click();
  await expect(driver.locator('#deliverPhotoBtn')).toBeDisabled();
  await driver.setInputFiles('#doorPhoto', photo('door.png'));
  await expect(driver.locator('#deliverPhotoBtn')).toBeEnabled();
  await driver.locator('#deliverPhotoBtn').click();

  await expect(customer.locator('#statusBadge')).toHaveText('Delivered');
  await expect(customer.locator('#proofList')).toContainText('no code');

  // Flagged for the office: check it, and it records who did.
  await goSection(operator, 'deliveries');
  await operator.locator(`#deliveries [data-open="${orderId}"]`).click();
  const delivered = operator.locator('#deliveryDetail');
  await expect(delivered).toContainText('No customer code');
  await delivered.locator('[data-review]').click();
  await expect(delivered).toContainText('Checked by');
});
