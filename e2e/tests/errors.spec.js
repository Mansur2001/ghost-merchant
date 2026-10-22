// When the server fails, the person sees what failed and a reference to report — never a
// button that silently does nothing.
import { test, expect } from '@playwright/test';
import { openApp, somaliNumber } from './helpers.js';

test('customer: a server failure shows the reason and the reference', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo);
  await page.route('**/api/auth/otp/request', (route) => route.fulfill({
    status: 502,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'could not send code', cause: 'SMS-21408', ref: '1a2b3c4d' }),
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /I'm a customer/ }).click();
  await page.fill('#phone', somaliNumber());
  await page.click('#sendCodeBtn');
  await expect(page.locator('#otpStatus')).toHaveText(
    "Couldn't send the code. Try again. If it keeps happening, tell us: 502 · SMS-21408 · ref 1a2b3c4d");
});

test('customer: the reference survives translation to Somali', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo);
  await page.route('**/api/auth/otp/request', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'database unavailable', cause: 'DB-P1001', ref: '1a2b3c4d' }),
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /I'm a customer/ }).click();
  await page.click('#langToggle');
  await page.fill('#phone', somaliNumber());
  await page.click('#sendCodeBtn');
  await expect(page.locator('#otpStatus')).toHaveText(/noo sheeg: 503 · DB-P1001 · ref 1a2b3c4d$/);
});

test('operator: a dead backend (Caddy 502, no JSON) is named, not silent', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo);
  await page.route('**/api/operator/login', (route) => route.fulfill({ status: 502, body: '' }));
  await page.goto('/operator/');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'not-the-password-1');
  await page.click('#loginBtn');
  await expect(page.locator('#loginHint')).toHaveText('server unavailable [502]');
});

test('the real server attaches a reference to its errors', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo);
  await page.goto('/');
  const body = await page.evaluate(async () => (await fetch('/api/orders/not-a-real-id', {
    headers: { Authorization: 'Bearer nonsense' },
  })).json());
  expect(body.error).toBeTruthy();
  expect(body.ref).toMatch(/^[0-9a-f]{8}$/);
});
