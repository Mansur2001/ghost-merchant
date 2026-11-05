// The whole business in one test, across the three apps: a customer orders and pays, the
// operator confirms and dispatches, the driver delivers — and the customer's page follows
// every step live over the WebSocket.
import { test, expect } from '@playwright/test';
import { openApp, signInCustomer, signInOperator, signInDriver, somaliNumber, SEED, DRIVER_PHONE, goSection } from './helpers.js';

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
  const card = operator.locator('#orders .card', { hasText: `#${short}` });
  await expect(card).toContainText('Customer says they paid with EVC Plus');
  await expect(card.locator(`[data-payref="${orderId}"]`)).toHaveValue(ref);
  await card.locator(`[data-confirm="${orderId}"]`).click();

  // Paid shows up on the customer's page without a reload.
  await expect(customer.locator('#statusBadge')).toHaveClass(/paid/);

  // Paid: the customer now has a delivery code, and only the customer sees it.
  await expect(customer.locator('#handoffCard')).toBeVisible();
  const code = (await customer.locator('#handoffCode').textContent()).trim();
  expect(code).toMatch(/^\d{4}$/);

  // Dispatch to the seeded driver — once the card has redrawn as paid, so the picker we fill
  // in is the one that stays on screen.
  await expect(card).toContainText('Needs a driver');
  const assign = operator.locator(`select[data-assign="${orderId}"]`);
  const amina = await assign.locator('option', { hasText: SEED.driver.name }).getAttribute('value');
  await assign.selectOption(amina);
  await operator.locator(`[data-assignbtn="${orderId}"]`).click();
  await expect(operator.locator('.toast')).toContainText('Driver assigned');

  // Driver: only their assigned order. Pickup needs the photo of the items first.
  const driver = await openApp(browser, testInfo, DRIVER_PHONE);
  await signInDriver(driver, SEED.driver);
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
  const delivered = operator.locator('#deliveries .card', { hasText: `#${short}` });
  await expect(delivered).toContainText('Customer gave the code');
  await expect(delivered).toContainText('Proven');

  // The customer's own check: "I didn't get my order" puts it back in front of an operator.
  await customer.locator('#disputeBtn').click();
  await customer.locator('#disputeBtn').click();
  await expect(customer.locator('#disputeNote')).toBeVisible();
  await goSection(operator, 'orders');
  await goSection(operator, 'deliveries');
  await expect(delivered).toContainText('Customer says not received');
  await expect(delivered).toContainText('Check');
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
  const card = operator.locator('#orders .card', { hasText: `#${short}` });
  await operator.fill(`[data-payref="${orderId}"]`, `NC${Date.now().toString().slice(-7)}`);
  await card.locator(`[data-confirm="${orderId}"]`).click();
  await expect(card).toContainText('Needs a driver');
  const assign = operator.locator(`select[data-assign="${orderId}"]`);
  await assign.selectOption(await assign.locator('option', { hasText: SEED.driver.name }).getAttribute('value'));
  await operator.locator(`[data-assignbtn="${orderId}"]`).click();
  await expect(operator.locator('.toast')).toContainText('Driver assigned');

  const driver = await openApp(browser, testInfo, DRIVER_PHONE);
  await signInDriver(driver, SEED.driver);
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
  const delivered = operator.locator('#deliveries .card', { hasText: `#${short}` });
  await expect(delivered).toContainText('No customer code');
  await delivered.locator('[data-review]').click();
  await expect(delivered).toContainText('Checked by');
});
