// Turn-by-turn and OpenStreetMap search (staging runs OSRM with the Somalia road network).
import { test, expect } from '@playwright/test';
import { openApp, signInCustomer, signInDriver, somaliNumber, SEED } from './helpers.js';

test('driver: start navigation on a job -> next turn, distance and arrival time on a full-screen map', async ({ browser }, testInfo) => {
  // Cali has the seeded ride, pickup at KM4. His phone is ~1.5 km away.
  const driver = await openApp(browser, testInfo, { permissions: ['geolocation'], geolocation: { latitude: 2.0400, longitude: 45.3150, accuracy: 10 } });
  await signInDriver(driver, SEED.drivers.Cali);
  await driver.locator('#queue .tile').first().click();
  await expect(driver.locator('#dTargetTitle')).toHaveText('Pick up the rider');
  await driver.click('#navStart');
  await expect(driver.locator('#navView')).toBeVisible();
  await expect(driver.locator('#navDist')).toHaveText(/\d+(\.\d)? (m|km)/, { timeout: 15000 });
  await expect(driver.locator('#navText')).not.toHaveText(/Finding the route/);
  await expect(driver.locator('#navEta')).toContainText('min');
  await expect(driver.locator('#navNote')).toBeHidden(); // a real route, not the straight-line fallback
  await expect(driver.locator('#navMap path.gm-route')).toHaveCount(1);
  // Arriving: move the phone onto the pickup.
  await driver.context().setGeolocation({ latitude: 2.0295, longitude: 45.3045, accuracy: 8 });
  await expect(driver.locator('#navText')).toHaveText('You have arrived', { timeout: 15000 });
  await driver.click('#navExit');
  await expect(driver.locator('#navView')).toBeHidden();
});

test('customer: search OpenStreetMap for a destination; the road route is drawn', async ({ browser }, testInfo) => {
  const rider = await openApp(browser, testInfo, { permissions: ['geolocation'], geolocation: { latitude: 2.0478, longitude: 45.3291 } });
  await signInCustomer(rider, somaliNumber());
  await rider.click('#goRide');
  await expect(rider.locator('#pickupText')).toContainText('My location');
  await rider.fill('#placeSearch', 'Banadir Hospital');
  await rider.press('#placeSearch', 'Enter');
  const osm = rider.locator('#placeResults .place-result', { has: rider.locator('.tag') }).first();
  await expect(osm).toBeVisible({ timeout: 15000 });
  await expect(rider.locator('#placeResults .osm-attrib')).toHaveCount(0); // no credit line under results
  await osm.click();
  await expect(rider.locator('#dropoffText')).toContainText(/Ben?adir|Banaadir/i);
  await expect(rider.locator('#rideMap path.gm-route')).toHaveCount(1, { timeout: 10000 });
  await expect(rider.locator('#rideOptions .ride-option')).toHaveCount(2);
});

test('customer: the driver coming to them is shown on the road route with a live arrival time', async ({ browser }, testInfo) => {
  // The seeded ride (Cali, bajaj) belongs to +252 77 123 4567.
  const rider = await openApp(browser, testInfo);
  await signInCustomer(rider, '771234567');
  await rider.click('.tabbar [data-tab="orders"]');
  await rider.locator('#resumeList .tile', { hasText: 'Ride' }).first().click();
  await expect(rider.locator('#driverStrip')).toBeVisible();
  await expect(rider.locator('#orderMap path.gm-route')).toHaveCount(1, { timeout: 10000 });
  await expect(rider.locator('#driverEta')).toContainText('min');
});
