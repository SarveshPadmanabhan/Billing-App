import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * Critical-path smoke test.
 *
 * Scope is deliberately narrow: sign in, reach an authenticated page, perform
 * one real write, and assert no browser errors along the way. That combination
 * is what would have caught the CORS-preflight and module-resolution failures
 * that API-only tests passed straight through.
 */

const SEED_OWNER = { email: 'owner@acme.test', password: 'DevPassword123!' };
const SEED_ORG_ID = '11111111-1111-1111-1111-111111111111';
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000';

/**
 * Collect browser-side errors for the lifetime of a page.
 *
 * Benign noise is filtered so the assertion stays meaningful; anything else
 * fails the test rather than scrolling past in the log.
 */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.includes('Download the React DevTools')) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}

/** Sign in through the real form and select the seeded organisation. */
async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#email', SEED_OWNER.email);
  await page.fill('#password', SEED_OWNER.password);
  await page.click('button[type=submit]');

  // A fresh session has no active organisation, so the app may route to
  // onboarding first.
  await page.waitForURL(/\/(dashboard|onboarding)/);

  await page.evaluate(
    async ([apiUrl, orgId]) => {
      await fetch(`${apiUrl}/api/v1/auth/switch-organisation`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organisationId: orgId }),
      });
    },
    [API_URL, SEED_ORG_ID],
  );
}

test.describe('smoke', () => {
  test('unauthenticated visitor is redirected to login', async ({ page }) => {
    await page.goto('/customers');
    await expect(page).toHaveURL(/\/login/);
    // The intended destination is preserved for post-login redirect.
    expect(page.url()).toContain('next=%2Fcustomers');
  });

  test('sign-in works from a real browser', async ({ page }) => {
    const errors = collectErrors(page);

    // Regression guard: this failed entirely when CORS preflight was
    // misconfigured, while curl-based tests kept passing.
    await signIn(page);
    await page.goto('/dashboard');

    await expect(page.locator('h1')).toContainText('Dashboard');
    expect(errors, `browser errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('authenticated navigation reaches every module', async ({ page }) => {
    const errors = collectErrors(page);
    await signIn(page);

    for (const [path, heading] of [
      ['/dashboard', 'Dashboard'],
      ['/customers', 'Customers'],
      ['/quotations', 'Quotations'],
      ['/invoices', 'Invoices'],
      ['/payments', 'Payments'],
      ['/reports', 'Reports'],
      ['/settings', 'Settings'],
    ] as const) {
      await page.goto(path);
      await expect(page.locator('h1')).toContainText(heading);
    }

    expect(errors, `browser errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('a customer can be created and read back', async ({ page }) => {
    const errors = collectErrors(page);
    await signIn(page);

    const name = `Smoke Test Co ${Date.now()}`;

    await page.goto('/customers/new');
    await page.fill('#companyName', name);
    await page.fill('#email', 'smoke@test.local');
    await page.click('button[type=submit]');

    // Landing on the detail page proves the write reached the database and the
    // response round-tripped.
    await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/);
    await expect(page.locator('h1')).toContainText(name);

    // And it appears in the list.
    await page.goto('/customers');
    await page.fill('#customer-search', name);
    await expect(page.locator('tbody tr')).toHaveCount(1);

    expect(errors, `browser errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('server-side validation surfaces on the form', async ({ page }) => {
    await signIn(page);
    await page.goto('/customers/new');

    // A company with no name must be refused, and the message shown inline.
    await page.click('button[type=submit]');
    await expect(page.getByText('Company name is required')).toBeVisible();
    await expect(page).toHaveURL(/\/customers\/new/);
  });

  test('navigation works on a mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await page.goto('/customers');

    const menuButton = page.getByRole('button', { name: 'Open navigation menu' });
    await expect(menuButton).toBeVisible();

    await menuButton.click();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  });
});
