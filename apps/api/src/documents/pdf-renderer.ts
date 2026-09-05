import { internalError } from '../common/errors/app-error.js';

/**
 * HTML-to-PDF rendering, behind one interface with two implementations.
 *
 * The split exists because the deployment target cannot run Chromium.
 * Vercel's serverless functions cap an unzipped bundle at 250MB and a
 * Chromium build alone is larger than that, so a local browser is not a
 * configuration away — it is impossible there. Rendering therefore moves to a
 * remote service in production while local development keeps Playwright, which
 * needs no account, no network and no key.
 *
 * Both take the same self-contained HTML and must produce the same A4 page, so
 * the print settings below are duplicated deliberately: they are the contract,
 * and changing one without the other silently alters every document's layout.
 */

export interface PdfRenderer {
  render(html: string): Promise<Buffer>;
  close(): Promise<void>;
}

/** A4, backgrounds on, CSS @page respected. Must match across renderers. */
const PAGE = {
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: true,
} as const;

/**
 * Local Chromium via Playwright. Used in development and in any container
 * host that can carry the browser.
 */
export class PlaywrightPdfRenderer implements PdfRenderer {
  private browser: import('playwright').Browser | null = null;
  private browserPromise: Promise<import('playwright').Browser> | null = null;

  private async getBrowser() {
    if (this.browser?.isConnected()) return this.browser;

    // Concurrent callers share one launch rather than starting several.
    this.browserPromise ??= import('playwright')
      .then(({ chromium }) =>
        chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
      )
      .then((browser) => {
        this.browser = browser;
        this.browserPromise = null;
        return browser;
      })
      .catch((error) => {
        this.browserPromise = null;
        throw error;
      });

    return this.browserPromise;
  }

  async render(html: string): Promise<Buffer> {
    const browser = await this.getBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // No network fetches: the template is self-contained and the logo is a
      // data URI, so `domcontentloaded` is sufficient and avoids waiting on
      // requests that will never happen.
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      return await page.pdf(PAGE);
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}

/**
 * Remote Chromium over Browserless' HTTP API.
 *
 * The document HTML is sent to a third party to be rendered. That HTML
 * contains customer names, addresses, line items and totals — so this is a
 * genuine processor relationship and belongs in the handover notes, not a
 * silent implementation detail.
 *
 * Nothing is persisted there: Browserless renders and returns. The token is
 * a server-side secret and must never reach the browser bundle.
 */
export class BrowserlessPdfRenderer implements PdfRenderer {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    /**
     * Below Vercel's function timeout, so a hung render surfaces as our own
     * error with a request id rather than the platform killing the function
     * and returning an opaque 504.
     */
    private readonly timeoutMs = 25_000,
  ) {}

  async render(html: string): Promise<Buffer> {
    // AbortController, not just the service's own timeout: without a client
    // deadline a stalled connection hangs until the platform kills it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      const url = new URL('/pdf', this.endpoint);
      url.searchParams.set('token', this.token);

      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html,
          options: PAGE,
          // The template is self-contained, so waiting for network idle would
          // add latency for requests that never happen.
          gotoOptions: { waitUntil: 'domcontentloaded' },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw internalError(`PDF render timed out after ${this.timeoutMs}ms`);
      }
      throw internalError(
        `PDF render request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The body may echo the document HTML, which carries customer data, so
      // only the status is surfaced — never the response text.
      throw internalError(`PDF render failed with status ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // A 200 carrying an error page would otherwise be stored and served as a
    // corrupt download. Every PDF begins with %PDF-.
    if (buffer.length === 0 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw internalError('PDF render returned a response that was not a PDF');
    }

    return buffer;
  }

  async close(): Promise<void> {
    // Stateless HTTP: nothing to tear down.
  }
}
