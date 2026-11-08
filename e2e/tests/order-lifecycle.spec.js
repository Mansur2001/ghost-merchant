// The whole business in one test, across the three apps: a customer orders and pays, the
// operator confirms and dispatches, the driver delivers — and the customer's page follows
// every step live over the WebSocket.
import { test, expect } from '@playwright/test';
import {
  openApp, signInCustomer, signInOperator, signInDriver, somaliNumber, SEED, DRIVER_PHONE, CUSTOMER_PHONE,
  goSection, assignedDriver, driversOnline, placeDelivery,
} from './helpers.js';

// A 1×1 PNG: the server checks a photo exists, not what's in it.
const photo = (name) => ({
  name,
  mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
});

test('cart → pay → confirm → dispatch → pickup photo → customer code, live on the customer page', async ({ browser, request }, testInfo) => {
  await driversOnline(request);
  const customer = await openApp(browser, testInfo, CUSTOMER_PHONE);
  await signInCustomer(customer, somaliNumber());

  // Place the order from the catalog; the server prices it.
  const { orderId, total } = await placeDelivery(customer, { n: 2, landmark: 'Staging landmark — green gate by the pharmacy' });
  await expect(customer.locator('#orderTotal')).toHaveText(total);
  await expect(customer.locator('#orderMapCard')).toBeVisible();

  // The wallet picker: one button per configured wallet, with the # still %23-encoded and the
  // server's total in it.
  const pay = customer.locator('#payWallets a');
  await expect(pay).toHaveCount(1);
  await expect(pay).toHaveText('Pay with EVC Plus');
  await expect(pay).toHaveAttribute('href', `tel:*712*612345678*${total}%23`);

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
  await expect(card).toContainText('Driver assigned');
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

  // At the customer's door now (the phone's GPS moves with the driver).
  await driver.context().setGeolocation(CUSTOMER_PHONE.geolocation);
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

test('a delivery without the code needs a door photo and a reason, and waits for an operator', async ({ browser, request }, testInfo) => {
  await driversOnline(request);
  const customer = await openApp(browser, testInfo, CUSTOMER_PHONE);
  await signInCustomer(customer, somaliNumber());
  // Something not in the catalog: a free-text line with its own budget.
  const { orderId } = await placeDelivery(customer, { n: 0, custom: { text: 'Staging: red school shoes, size 34', budget: 3 }, landmark: 'Staging landmark — blue door' });

  const operator = await openApp(browser, testInfo);
  await signInOperator(operator, SEED.dispatcher);
  const card = operator.locator(`#orders [data-open="${orderId}"]`);
  await card.click();
  await operator.fill(`[data-payref="${orderId}"]`, `NC${Date.now().toString().slice(-7)}`);
  await operator.locator(`[data-confirm="${orderId}"]`).click();
  await expect(card).toContainText('Driver assigned');
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
