// Playwright against local staging. Start it first: ./scripts/staging.sh up
// Run through the wrapper (./scripts/staging.sh test), which also clears rate limits.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // One at a time: the workflows share one staging database and one rate limiter.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.STAGING_URL || 'https://localhost:8444',
    // Caddy's local certificate isn't trusted by a fresh browser profile.
    ignoreHTTPSErrors: true,
    // ...and ignoreHTTPSErrors alone doesn't cover service-worker scripts: Chromium still refuses
    // to register sw.js over an untrusted certificate. Staging's cert is local and self-issued.
    launchOptions: { args: ['--ignore-certificate-errors'] },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // A phone-sized Chrome: customers and drivers use the app on Android handsets.
  projects: [{ name: 'mobile-chrome', use: { ...devices['Pixel 7'] } }],
});
