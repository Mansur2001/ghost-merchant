// A ride, across the three apps: the rider sets pickup (GPS) and destination (search), sees a
// fare per vehicle, books, pays IN THE APP (the staging WaafiPay simulator stands in for
// Sahal), the nearest free car is dispatched, the rider watches it come, gives their code at
// pickup, and the trip ends at the destination.
import { test, expect } from '@playwright/test';
import { openApp, signInCustomer, signInDriver, signInOperator, somaliNumber, SEED, driversOnline, goSection } from './helpers.js';

const PICKUP = { latitude: 2.0478, longitude: 45.3291 }; // by the stadium

test('book a car → pay in the app → nearest driver → rider code → drop-off', async ({ browser, request }, testInfo) => {
  // Amina goes online first and takes any delivery left waiting, so Bashir (the car) is free.
  await driversOnline(request, ['Amina']);
  const driver = await openApp(browser, testInfo, { permissions: ['geolocation'], geolocation: { latitude: 2.0471, longitude: 45.3300 } });
  await signInDriver(driver, SEED.drivers.Bashir);
  // The driver's own switch: online shares the phone's position.
  await expect(driver.locator('#onlineBtn')).toBeVisible();
  if ((await driver.locator('#onlineState').textContent()).includes('offline')) await driver.click('#onlineBtn');
  await expect(driver.locator('#onlineState')).toHaveText('You are online');
  await expect(driver.locator('#locLine')).toContainText('Sharing your location');

  const rider = await openApp(browser, testInfo, { permissions: ['geolocation'], geolocation: PICKUP });
  await signInCustomer(rider, somaliNumber());
  await rider.click('#goRide');
  await expect(rider.locator('#pickupText')).toContainText('My location');
  await rider.fill('#placeSearch', 'Airport');
  await rider.locator('#placeResults .place-result').first().click();
  await expect(rider.locator('#dropoffText')).toContainText('Airport');

  // A fare for each vehicle; the car shows a driver nearby.
  const car = rider.locator('#rideOptions .ride-option', { hasText: 'Car' });
  await expect(car).toContainText('1 nearby');
  await car.click();
  const fare = (await car.locator('.ro-price').textContent()).trim();
  await expect(rider.locator('#rideBook')).toHaveText(`Book Car · ${fare}`);
  await rider.fill('#ridePhone', '612345678');
  await rider.click('#rideBook');
  await expect(rider.locator('#orderView')).toBeVisible();
  await expect(rider.locator('#statusTitle')).toHaveText('Awaiting payment');
  const orderId = await rider.evaluate(() => JSON.parse(localStorage.getItem('gm_last')).orderId);

  // Pay in the app: a prompt on the phone (the simulator approves), no operator involved.
  await expect(rider.locator('#appPay')).toBeVisible();
  await rider.fill('#payPhone', '901234567');
  await rider.locator('#appPayButtons button', { hasText: 'Sahal' }).click();
  await expect(rider.locator('#appPayStatus')).toContainText('Check your phone');
  await expect(rider.locator('#statusTitle')).toHaveText('Driver on the way', { timeout: 15000 });

  // The rider sees who is coming and how far.
  await expect(rider.locator('#driverStrip')).toBeVisible();
  await expect(rider.locator('#driverName')).toHaveText('Bashir');
  await expect(rider.locator('#handoffCard')).toContainText('Your ride code');
  const code = (await rider.locator('#handoffCode').textContent()).trim();

  // The driver got it (no reload), with the pickup as the place to go.
  const job = driver.locator(`#queue [data-id="${orderId}"]`);
  await expect(job).toBeVisible({ timeout: 10000 });
  await job.click();
  await expect(driver.locator('#dTargetTitle')).toHaveText('Pick up the rider');
  await expect(driver.locator('#shopCard')).toBeHidden();
  await expect(driver.locator('#jobMap')).toBeVisible();

  // A wrong code is refused; the right one starts the trip.
  await driver.fill('#codeIn', code === '0000' ? '1111' : '0000');
  await driver.click('#rideStartBtn');
  await expect(driver.locator('#codeMsg')).toContainText('4 tries left');
  await driver.fill('#codeIn', code);
  await driver.click('#rideStartBtn');
  await expect(rider.locator('#statusTitle')).toHaveText('On your trip');
  await expect(driver.locator('#dTargetTitle')).toHaveText('Take the rider to');

  await driver.click('#rideEndBtn');
  await expect(rider.locator('#statusTitle')).toHaveText('Arrived');
  await expect(rider.locator('#proofList')).toContainText('Picked up with your code');
  await expect(rider.locator('#driverStrip')).toBeHidden();

  // The desk saw it all, and paid-by-app needed no confirmation from anyone.
  const operator = await openApp(browser, testInfo);
  await signInOperator(operator, SEED.dispatcher);
  await goSection(operator, 'map');
  await expect(operator.locator('#mapDrivers')).toContainText('Bashir');
});

test('a rider can cancel before a driver is found, and is owed a refund if they paid', async ({ browser }, testInfo) => {
  const rider = await openApp(browser, testInfo, { permissions: ['geolocation'], geolocation: PICKUP });
  await signInCustomer(rider, somaliNumber());
  await rider.click('#goRide');
  await expect(rider.locator('#pickupText')).toContainText('My location');
  await rider.fill('#placeSearch', 'Lido');
  await rider.locator('#placeResults .place-result').first().click();
  // Bajaj: none free (Cali has a rider, Amina is busy), so it will wait once paid.
  await rider.locator('#rideOptions .ride-option', { hasText: 'Bajaj' }).click();
  await rider.fill('#ridePhone', '612345678');
  await rider.click('#rideBook');
  await expect(rider.locator('#orderView')).toBeVisible();
  await rider.fill('#payPhone', '612345678');
  await rider.locator('#appPayButtons button', { hasText: 'EVC' }).click();
  await expect(rider.locator('#statusTitle')).toHaveText('Finding a driver', { timeout: 15000 });
  await rider.click('#cancelBtn');
  await rider.click('#cancelBtn');
  await expect(rider.locator('#statusTitle')).toHaveText('Cancelled');
  await expect(rider.locator('#thread')).toContainText('We owe you a refund');
});
