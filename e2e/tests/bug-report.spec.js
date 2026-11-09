// Report a problem (Help) -> Bug reports (desk). The team bug tracker's three outcomes:
// inline field errors, "filed as #N", and a network failure that keeps what was typed.
import { test, expect } from '@playwright/test';
import { openApp, signInCustomer, signInOperator, somaliNumber, SEED, goSection } from './helpers.js';

test('a signed-out visitor reports a bug: inline errors, then "filed as #N"; the desk triages it', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo);
  await page.goto('/');
  await page.click('.tabbar [data-tab="help"]');
  await page.locator('#bugBox summary').click();
  await expect(page.locator('#bugEmailWrap')).toBeVisible(); // signed out: optional email offered

  // Validation: both required fields flagged next to themselves; nothing sent.
  await page.click('#bugSend');
  await expect(page.locator('#bugTitleErr')).toHaveText('Say in a few words what went wrong.');
  await expect(page.locator('#bugDescErr')).toHaveText('Tell us what happened.');
  await expect(page.locator('#bugTitle')).toHaveAttribute('aria-invalid', 'true');

  const title = `Map stays blank ${Date.now()}`;
  await page.fill('#bugTitle', title);
  await expect(page.locator('#bugTitleErr')).toHaveText('');
  await expect(page.locator('#bugForm .counter[data-for="bugTitle"]')).toHaveText(`${title.length} / 200`);
  await page.fill('#bugDesc', 'Opened Ride, the map shows only a grid.');
  await page.fill('#bugSteps', '1. Open Ride 2. Wait');
  await page.fill('#bugEmail', 'tester@example.com');

  // Network failure: a calm message, and everything typed is still there.
  await page.route('**/api/bugs', (r) => r.abort());
  await page.click('#bugSend');
  await expect(page.locator('#bugErr')).toContainText('Your report is still here');
  await expect(page.locator('#bugTitle')).toHaveValue(title);
  await page.unroute('**/api/bugs');

  await page.click('#bugSend');
  await expect(page.locator('#bugOk')).toContainText(/filed as #\d+/);
  await expect(page.locator('#bugOk')).toBeFocused();
  await expect(page.locator('#bugTitle')).toHaveValue('');
  const id = (await page.locator('#bugOk').textContent()).match(/#(\d+)/)[1];

  const desk = await openApp(browser, testInfo);
  await signInOperator(desk, SEED.dispatcher);
  await goSection(desk, 'bugs');
  const row = desk.locator(`#bugList [data-open="${id}"]`);
  await expect(row).toContainText(title);
  await row.click();
  await expect(desk.locator('#bugDetail')).toContainText('signed-out visitor');
  await expect(desk.locator('#bugDetail')).toContainText('tester@example.com');
  await desk.selectOption('#bugStatusSel', 'in_progress');
  await desk.fill('#bugNote', 'Street map file was missing on staging.');
  await desk.click('#bugSave');
  await expect(desk.locator('#bugDetail')).toContainText('Last change');
  await expect(row).toHaveCount(0); // left the "Open" filter
});

test('a signed-in customer reports: account attached from the session, no email asked', async ({ browser }, testInfo) => {
  const page = await openApp(browser, testInfo);
  await signInCustomer(page, somaliNumber());
  await page.click('.tabbar [data-tab="help"]');
  await page.locator('#bugBox summary').click();
  await expect(page.locator('#bugEmailWrap')).toBeHidden();
  await page.fill('#bugTitle', 'Somali text cut off');
  await page.fill('#bugDesc', 'On the ride screen the Somali button text is cut.');
  await page.locator('#langToggle').click(); // the report records the language in use
  await page.click('#bugSend');
  await expect(page.locator('#bugOk')).toContainText('#');
});
