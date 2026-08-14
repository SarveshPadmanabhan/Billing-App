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
 * Tests that create records use their own organisation rather than the seeded
 * one. Writing into the seed pollutes the dataset every run — after enough
 * runs the demo organisation filled with "Smoke Test Co" customers and dozens
 * of throwaway invoices, which made the dashboard and lists useless for
 * eyeballing real behaviour.
 *
 * Read-only tests still use the seeded organisation, because its data is
 * realistic and covers every document state.
 */
const SCRATCH_PASSWORD = 'CorrectHorseBattery1';

async function signInToScratchOrg(page: Page): Promise<void> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `e2e-${stamp}@scratch.test`;

  await page.goto('/login');
  await page.evaluate(
    async ([apiUrl, userEmail, password]) => {
      await fetch(`${apiUrl}/api/v1/auth/sign-up/email`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: userEmail,
          password,
          name: 'E2E Scratch',
          firstName: 'E2E',
          lastName: 'Scratch',
        }),
      });
      await fetch(`${apiUrl}/api/v1/auth/sign-in/email`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userEmail, password }),
      });
      await fetch(`${apiUrl}/api/v1/organisations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'E2E Scratch Org', currencyCode: 'INR', countryCode: 'IN' }),
      });
      await fetch(`${apiUrl}/api/v1/customers`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerType: 'COMPANY', companyName: 'Scratch Client' }),
      });
    },
    [API_URL, email, SCRATCH_PASSWORD] as const,
  );
}

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
    await signInToScratchOrg(page);

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
    await signInToScratchOrg(page);
    await page.goto('/customers/new');

    // A company with no name must be refused, and the message shown inline.
    await page.click('button[type=submit]');
    await expect(page.getByText('Company name is required')).toBeVisible();
    await expect(page).toHaveURL(/\/customers\/new/);
  });

  test('a quotation can be created, sent, accepted and converted', async ({ page }) => {
    const errors = collectErrors(page);
    await signInToScratchOrg(page);

    await page.goto('/quotations/new');
    await page.waitForSelector('#customerId');
    await page.selectOption('#customerId', { index: 1 });

    await page.fill('input[aria-label="Description for line 1"]', 'E2E service');
    await page.fill('input[aria-label="Quantity for line 1"]', '3');
    await page.fill('input[aria-label="Unit price for line 1"]', '1000');
    await page.fill('input[aria-label="Tax percent for line 1"]', '18');

    await page.click('button[type=submit]');
    await page.waitForURL(/\/quotations\/[0-9a-f-]{36}$/);

    // Totals must come from the server: 3 x 1000 = 3000, +18% = 3540.
    await expect(page.getByText('INR 3,540.00').first()).toBeVisible();

    // Send — this also renders the PDF inside the same transaction.
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByRole('button', { name: 'Send quotation' }).click();
    await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();

    // Editing must no longer be offered once sent.
    await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Mark accepted' }).first().click();
    await page.getByRole('button', { name: 'Mark accepted' }).last().click();
    await expect(page.getByRole('button', { name: 'Convert to invoice' })).toBeVisible();

    await page.getByRole('button', { name: 'Convert to invoice' }).click();
    await page.getByRole('button', { name: 'Create invoice' }).click();
    await expect(page.getByText(/Invoice INV-\d+ created/)).toBeVisible();

    expect(errors, `browser errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('an invoice can be created, sent and cancelled', async ({ page }) => {
    const errors = collectErrors(page);
    await signInToScratchOrg(page);

    await page.goto('/invoices/new');
    await page.waitForSelector('#customerId');
    await page.selectOption('#customerId', { index: 1 });

    await page.fill('input[aria-label="Description for line 1"]', 'E2E invoice line');
    await page.fill('input[aria-label="Quantity for line 1"]', '2');
    await page.fill('input[aria-label="Unit price for line 1"]', '1500');
    await page.fill('input[aria-label="Tax percent for line 1"]', '18');

    await page.click('button[type=submit]');
    await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);

    // 2 x 1500 = 3000, +18% = 3540, all outstanding.
    const balance = page.getByLabel('Balance');
    await expect(balance).toContainText('INR 3,540.00');

    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByRole('button', { name: 'Send invoice' }).click();
    await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);

    // Cancellation must state a reason — the API rejects an empty one.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel invoice' }).click();
    await expect(page.getByText('A reason is required to cancel an invoice')).toBeVisible();

    await page.fill('#cancel-reason', 'Raised in error during E2E run');
    await page.getByRole('button', { name: 'Cancel invoice' }).click();
    await expect(page.getByText('Raised in error during E2E run')).toBeVisible();

    // A cancelled invoice owes nothing but keeps its total on record.
    await expect(balance).toContainText('INR 0.00');

    expect(errors, `browser errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('navigation works on a mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await page.goto('/customers');

    const menuButton = page.getByRole('button', { name: 'Open navigation menu' });
    await expect(menuButton).toBeVisible();

    await menuButton.click();
    await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();
  });
});
