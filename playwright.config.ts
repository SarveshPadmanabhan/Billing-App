import { defineConfig, devices } from '@playwright/test';

/**
 * E2E smoke tests.
 *
 * These exist because API-level tests missed two failures that only appear in
 * a real browser: a CORS preflight that blocked every sign-in, and a module
 * specifier webpack could not resolve. Both returned healthy responses to curl.
 *
 * Deliberately small — a handful of critical paths, fast enough to run on
 * every change. Comprehensive coverage stays in the integration suites.
 *
 * Assumes the API (:4000) and web (:3000) are already running and the database
 * is seeded. `pnpm test:e2e` starts nothing; run `pnpm dev` first.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Shared seeded data; keep ordering deterministic.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
