import { test, expect, type Page } from '@playwright/test';

/**
 * TICKET-049 — the complete MVP workflow, end to end, through the browser.
 *
 *   Sign up → Organisation → Customer → Quotation → PDF → Accept →
 *   Convert to Invoice → Invoice PDF → Payment → Paid → Dashboard
 *
 * Distinct from smoke.spec.ts, which checks individual paths quickly. This is
 * one continuous journey by a brand-new user in a brand-new organisation, and
 * it verifies the numbers carry correctly from one step to the next — the
 * thing no single-module test can establish.
 *
 * It provisions its own organisation, so it runs against a clean slate
 * regardless of what else is in the database.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000';
const PASSWORD = 'CorrectHorseBattery1';

/** Figures the workflow must preserve, computed once and asserted throughout. */
const LINE = { description: 'Implementation services', qty: 4, rate: 25_000, taxRate: 18 };
const NET = LINE.qty * LINE.rate; // 100,000
const TAX = (NET * LINE.taxRate) / 100; // 18,000
const TOTAL = NET + TAX; // 118,000

const inr = (value: number) => `INR ${value.toLocaleString('en-IN')}.00`;

async function signUpAndOnboard(page: Page): Promise<void> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `workflow-${stamp}@e2e.test`;

  // Registration through the real form (TICKET-003).
  await page.goto('/register');
  await page.fill('#firstName', 'Workflow');
  await page.fill('#lastName', 'Tester');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');

  // A new user has no organisation, so the app routes to onboarding.
  await page.waitForURL(/\/onboarding/);
}

test.describe('core MVP workflow', () => {
  // The journey has many steps and renders two PDFs; the default is too tight.
  test.setTimeout(180_000);

  test('sign up through to a paid invoice on the dashboard', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('Download the React DevTools')) {
        errors.push(`console: ${m.text()}`);
      }
    });

    // --- 1. Sign up ---------------------------------------------------------
    await signUpAndOnboard(page);

    // --- 2. Create the organisation (TICKET-005) ----------------------------
    await page.fill('#name', 'Workflow Test Ltd');
    await page.fill('#taxNumber', '29WFLOW1234A1Z5');
    await page.selectOption('#currencyCode', 'INR');
    await page.click('button[type=submit]');

    await page.waitForURL(/\/dashboard/);
    await expect(page.locator('h1')).toContainText('Dashboard');

    // A brand-new organisation has nothing to show (TICKET-039 no-data case).
    await expect(page.getByText('Nothing billed yet')).toBeVisible();

    // --- 3. Add a customer (TICKET-010) -------------------------------------
    await page.goto('/customers/new');
    await page.fill('#companyName', 'Journey Customer Ltd');
    await page.fill('#email', 'ap@journey.test');
    await page.fill('#billing-line1', '10 Test Street');
    await page.fill('#billing-city', 'Bengaluru');
    await page.click('button[type=submit]');

    await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/);
    await expect(page.locator('h1')).toContainText('Journey Customer Ltd');

    // --- 4. Create a quotation (TICKET-016, TICKET-017) ---------------------
    await page.goto('/quotations/new');
    await page.waitForSelector('#customerId');
    await page.selectOption('#customerId', { index: 1 });
    await page.fill('input[aria-label="Description for line 1"]', LINE.description);
    await page.fill('input[aria-label="Quantity for line 1"]', String(LINE.qty));
    await page.fill('input[aria-label="Unit price for line 1"]', String(LINE.rate));
    await page.fill('input[aria-label="Tax percent for line 1"]', String(LINE.taxRate));
    await page.click('button[type=submit]');

    await page.waitForURL(/\/quotations\/[0-9a-f-]{36}$/);

    // Numbering starts at 1 for a new organisation (TICKET-015).
    await expect(page.locator('h1')).toContainText('QUO-000001');
    // Totals are the server's, not the form's (TICKET-017).
    await expect(page.getByText(inr(TOTAL)).first()).toBeVisible();

    // --- 5. Quotation PDF (TICKET-020) --------------------------------------
    const quotationPdf = await page.evaluate(async (apiUrl) => {
      const id = window.location.pathname.split('/').pop();
      const response = await fetch(`${apiUrl}/api/v1/quotations/${id}/pdf`, {
        credentials: 'include',
      });
      const body = await response.json();
      if (!body.data?.url) return { ok: false, size: 0 };
      const file = await fetch(body.data.url);
      const bytes = await file.arrayBuffer();
      return { ok: file.ok, size: bytes.byteLength };
    }, API_URL);

    expect(quotationPdf.ok, 'quotation PDF downloads').toBe(true);
    expect(quotationPdf.size, 'quotation PDF has content').toBeGreaterThan(1000);

    // --- 6. Send and accept (TICKET-019) ------------------------------------
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByRole('button', { name: 'Send quotation' }).click();
    await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Mark accepted' }).first().click();
    await page.getByRole('button', { name: 'Mark accepted' }).last().click();
    await expect(page.getByRole('button', { name: 'Convert to invoice' })).toBeVisible();

    // --- 7. Convert to an invoice (TICKET-022) ------------------------------
    await page.getByRole('button', { name: 'Convert to invoice' }).click();
    await page.getByRole('button', { name: 'Create invoice' }).click();
    await expect(page.getByText(/Invoice INV-\d+ created/)).toBeVisible();

    // The quotation is preserved and linked, not replaced.
    await expect(page.getByText('Converted', { exact: true }).first()).toBeVisible();
    await page.getByRole('link', { name: /INV-\d+/ }).first().click();
    await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/);

    // Amounts carried across exactly as quoted.
    await expect(page.locator('h1')).toContainText('INV-000001');
    const balance = page.getByLabel('Balance');
    await expect(balance).toContainText(inr(TOTAL));

    // --- 8. Send the invoice, then its PDF (TICKET-028, TICKET-029) ---------
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByRole('button', { name: 'Send invoice' }).click();
    await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();

    const invoicePdf = await page.evaluate(async (apiUrl) => {
      const id = window.location.pathname.split('/').pop();
      const response = await fetch(`${apiUrl}/api/v1/invoices/${id}/pdf`, {
        credentials: 'include',
      });
      const body = await response.json();
      if (!body.data?.url) return { ok: false, size: 0 };
      const file = await fetch(body.data.url);
      const bytes = await file.arrayBuffer();
      return { ok: file.ok, size: bytes.byteLength };
    }, API_URL);

    expect(invoicePdf.ok, 'invoice PDF downloads').toBe(true);
    expect(invoicePdf.size, 'invoice PDF has content').toBeGreaterThan(1000);

    // --- 9. Record a partial payment, then settle (TICKET-031, TICKET-032) --
    await page.getByRole('button', { name: 'Record payment' }).click();
    await page.fill('#payment-amount', '18000');
    await page.getByRole('button', { name: 'Record payment' }).last().click();
    await expect(balance).toContainText(inr(NET)); // 118,000 - 18,000 = 100,000
    await expect(page.getByText('Partially paid').first()).toBeVisible();

    await page.getByRole('button', { name: 'Record payment' }).click();
    // The dialog prefills the remaining balance, so settling is one click.
    await page.getByRole('button', { name: 'Record payment' }).last().click();

    // --- 10. Invoice is PAID with a zero balance ----------------------------
    await expect(page.getByText('Paid', { exact: true }).first()).toBeVisible();
    await expect(balance).toContainText('INR 0.00');
    // Both payments are on record.
    await expect(page.getByText(/PAY-00000[12]/).first()).toBeVisible();

    // --- 11. The dashboard reflects all of it (TICKET-039) ------------------
    await page.goto('/dashboard');
    await page.waitForSelector('section[aria-label="Key figures"]');

    const kpis = page.getByLabel('Key figures');
    await expect(kpis).toContainText(inr(TOTAL)); // invoiced
    await expect(kpis).toContainText('INR 0.00'); // outstanding and overdue
    await expect(page.getByText('Nothing billed yet')).toHaveCount(0);

    // Total paid must equal the invoice total now that it is settled. The KPI
    // cards are divs (some wrapped in links), so match on the heading's
    // container rather than assuming an element type.
    const paidCard = page
      .getByRole('heading', { name: 'Total paid' })
      .locator('xpath=..');
    await expect(paidCard).toContainText(inr(TOTAL));

    // And the settled invoice appears under recent documents.
    await expect(page.getByRole('link', { name: 'INV-000001' })).toBeVisible();

    expect(errors, `browser errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
