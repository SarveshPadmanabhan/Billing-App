import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { chromium, type Browser } from 'playwright';
import { withTenant, Prisma, type TenantClient } from '@billing/database';
import type { OrganisationContext } from '@billing/types';
import { StorageService } from './storage.service.js';
import { renderDocumentHtml, type TemplateData, type TemplateLineItem } from './document-template.js';
import type { AppLogger } from '../common/logging/logger.js';
import { notFound, internalError } from '../common/errors/app-error.js';

/**
 * PDF generation for quotations and invoices (TICKET-020, TICKET-029).
 *
 * Synchronous on first request, then cached in object storage. A user clicking
 * "Download" expects a file, not a job id, and the queued alternative adds a
 * failure mode where the document exists but its PDF silently never appears.
 * BullMQ remains for email and reminders.
 *
 * Three safeguards:
 *
 * 1. Cache key is a hash of rendered content, not updated_at. updated_at
 *    changes on writes that do not affect the PDF and misses changes that do
 *    (a payment alters an invoice's status badge and balance via another row).
 *
 * 2. Concurrent generation is safe. A transaction-scoped advisory lock keyed
 *    on the entity serialises the documents-row write, backed by a unique
 *    (organisation_id, entity_id, document_type, version) index. Verified with
 *    10 simultaneous requests producing exactly one row.
 *
 * 3. `generate` can run inside a caller's transaction. Send uses that so a
 *    render failure rolls the status change back rather than leaving a
 *    document marked sent with no PDF.
 */

export type PdfEntityType = 'invoices' | 'quotations';

export interface GeneratedPdf {
  documentId: string;
  storageKey: string;
  contentHash: string;
  fileName: string;
  fileSize: number;
  /** False when an existing cached render was reused. */
  rendered: boolean;
  renderMs: number;
}

/** Enum values are not what a customer should read on a document. */
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  CARD: 'Card',
  CHEQUE: 'Cheque',
  UPI: 'UPI',
  OTHER: 'Other',
};

@Injectable()
export class PdfService implements OnModuleDestroy {
  /** One browser reused across requests; launching costs ~300ms each time. */
  private browser: Browser | null = null;
  private browserPromise: Promise<Browser> | null = null;

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject('APP_LOGGER') private readonly logger: AppLogger,
  ) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    // Concurrent callers share one launch rather than starting several.
    this.browserPromise ??= chromium
      .launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
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

  /**
   * Hash of everything the PDF displays.
   *
   * Any field that appears on the page must be included, or an edit would
   * serve a stale cached file. Fields that do not appear are excluded, so
   * irrelevant writes do not force a re-render.
   */
  private contentHash(data: TemplateData): string {
    const material = JSON.stringify({
      kind: data.kind,
      number: data.documentNumber,
      status: data.status,
      org: data.organisation,
      customer: data.customer,
      dates: data.dates,
      currency: data.currency,
      items: data.items,
      totals: data.totals,
      notes: data.notes,
      terms: data.terms,
      // generatedAt is deliberately excluded: including it would make every
      // request a cache miss.
    });
    return createHash('sha256').update(material).digest('hex');
  }

  /**
   * Produce (or reuse) the PDF for a document.
   *
   * @param tx Optional. Pass a transaction to tie the documents row to the
   *           caller's transaction, so a rollback discards it — used by send.
   */
  async generate(
    org: OrganisationContext,
    entityType: PdfEntityType,
    entityId: string,
    options: { userId: string; force?: boolean; tx?: TenantClient } = { userId: '' },
  ): Promise<GeneratedPdf> {
    const run = async (tx: TenantClient): Promise<GeneratedPdf> => {
      const data =
        entityType === 'invoices'
          ? await this.loadInvoice(tx, org.organisationId, entityId)
          : await this.loadQuotation(tx, org.organisationId, entityId);

      const hash = this.contentHash(data);
      const fileName = `${data.documentNumber}.pdf`;

      // Cache hit: same content already rendered and still in storage.
      if (!options.force) {
        const cached = await tx.document.findFirst({
          where: { organisationId: org.organisationId, entityId, contentHash: hash },
          orderBy: { version: 'desc' },
        });

        if (cached && (await this.storage.exists(cached.storageKey))) {
          return {
            documentId: cached.id,
            storageKey: cached.storageKey,
            contentHash: hash,
            fileName: cached.fileName,
            fileSize: cached.fileSize,
            rendered: false,
            renderMs: 0,
          };
        }
      }

      const startedAt = Date.now();
      const pdf = await this.render(renderDocumentHtml(data));
      const renderMs = Date.now() - startedAt;

      const key = this.storage.buildKey({
        organisationId: org.organisationId,
        entityType,
        entityId,
        contentHash: hash,
      });

      // Upload before the database row: an orphaned object is harmless, a row
      // pointing at a missing object is not.
      await this.storage.put(key, pdf);

      /**
       * Serialise the document-row write per entity.
       *
       * Two earlier approaches failed under a 10-way concurrent test:
       *
       *   - Reading MAX(version) then inserting: every request read the same
       *     max before any had inserted, so each computed a *different* next
       *     version and the unique index never fired. Result: 8 rows.
       *
       *   - Catching P2002 and re-querying: once a statement violates a
       *     constraint the Postgres transaction is aborted, so the recovery
       *     query fails with 25P02. Result: 500s.
       *
       * An advisory lock keyed on the entity fixes both. It is transaction-
       * scoped (released on commit or rollback), costs nothing when
       * uncontended, and is keyed per document so unrelated PDFs never block
       * each other. Losing requests wait, then take the cache-hit path below.
       */
      const lockKey = createHash('sha256')
        .update(`pdf:${org.organisationId}:${entityId}`)
        .digest();
      // Two 32-bit halves — pg_advisory_xact_lock(int4, int4).
      const lockA = lockKey.readInt32BE(0);
      const lockB = lockKey.readInt32BE(4);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockA}::int4, ${lockB}::int4)`;

      // Re-check inside the lock: a request that waited here will now find the
      // row the winner inserted and reuse it rather than making a duplicate.
      const afterLock = await tx.document.findFirst({
        where: { organisationId: org.organisationId, entityId, contentHash: hash },
        orderBy: { version: 'desc' },
      });
      if (afterLock) {
        this.logger.debug(
          { entityId, version: afterLock.version },
          'Concurrent PDF generation resolved to the row created while waiting',
        );
        return {
          documentId: afterLock.id,
          storageKey: afterLock.storageKey,
          contentHash: hash,
          fileName: afterLock.fileName,
          fileSize: afterLock.fileSize,
          rendered: false,
          renderMs,
        };
      }

      // Next version for this entity. Safe now: the lock is held. Old versions
      // are retained for audit rather than overwritten.
      const latest = await tx.document.findFirst({
        where: { organisationId: org.organisationId, entityId, documentType: entityType },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = (latest?.version ?? 0) + 1;

      const document = await tx.document.create({
        data: {
          organisationId: org.organisationId,
          companyId: org.companyId,
          documentType: entityType,
          entityId,
          storageKey: key,
          fileName,
          mimeType: 'application/pdf',
          fileSize: pdf.length,
          checksum: hash,
          contentHash: hash,
          version,
          createdBy: options.userId || null,
        },
      });

      this.logger.info(
        { entityType, entityId, renderMs, bytes: pdf.length, version },
        'Rendered document PDF',
      );

      return {
        documentId: document.id,
        storageKey: document.storageKey,
        contentHash: hash,
        fileName: document.fileName,
        fileSize: document.fileSize,
        rendered: true,
        renderMs,
      };
    };

    // Join the caller's transaction when given one, so a later failure in that
    // transaction discards this document row too.
    return options.tx ? run(options.tx) : withTenant(org.organisationId, run);
  }

  /** Authorised download URL. Callers must have checked permission first. */
  async downloadUrl(
    org: OrganisationContext,
    entityType: PdfEntityType,
    entityId: string,
    userId: string,
  ): Promise<{ url: string; fileName: string; expiresInSeconds: number }> {
    const generated = await this.generate(org, entityType, entityId, { userId });
    const url = await this.storage.signedDownloadUrl(generated.storageKey, generated.fileName);
    return { url, fileName: generated.fileName, expiresInSeconds: 300 };
  }

  private async render(html: string): Promise<Buffer> {
    const browser = await this.getBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // No network fetches: the template is self-contained and the logo is a
      // data URI, so `domcontentloaded` is sufficient and avoids waiting on
      // requests that will never happen.
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      return await page.pdf({
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true,
      });
    } catch (error) {
      throw internalError(
        `PDF render failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await context.close();
    }
  }

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  private formatDate(date: Date): string {
    return date.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }

  private addressLines(source: {
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    countryCode?: string | null;
  }): string[] {
    return [
      source.addressLine1,
      source.addressLine2,
      [source.city, source.state, source.postalCode].filter(Boolean).join(', ') || null,
      source.countryCode,
    ].filter((line): line is string => Boolean(line && line.trim()));
  }

  /**
   * Taxable value per line: the post-discount base its tax was computed on.
   *
   * Derived as lineTotal − taxAmount rather than recomputed from quantity and
   * price. The calculation engine apportions document-level discounts across
   * lines, so recomputing here could disagree with the stored figures; this
   * subtraction is exact and cannot drift from what was saved.
   */
  private taxableValue(lineTotal: Prisma.Decimal, taxAmount: Prisma.Decimal): string {
    return lineTotal.minus(taxAmount).toFixed(4);
  }

  private toTemplateItems(
    items: Array<{
      position: number;
      description: string;
      quantity: Prisma.Decimal;
      unit: string | null;
      unitPrice: Prisma.Decimal;
      discountAmount: Prisma.Decimal;
      taxRate: Prisma.Decimal;
      taxAmount: Prisma.Decimal;
      lineTotal: Prisma.Decimal;
    }>,
  ): TemplateLineItem[] {
    return items.map((item) => ({
      position: item.position,
      description: item.description,
      quantity: item.quantity.toFixed(4),
      unit: item.unit,
      unitPrice: item.unitPrice.toFixed(4),
      discountAmount: item.discountAmount.toFixed(4),
      taxableValue: this.taxableValue(item.lineTotal, item.taxAmount),
      taxRate: item.taxRate.toFixed(4),
      taxAmount: item.taxAmount.toFixed(4),
      lineTotal: item.lineTotal.toFixed(4),
    }));
  }

  private async loadOrganisation(tx: TenantClient, organisationId: string) {
    const org = await tx.organisation.findUniqueOrThrow({ where: { id: organisationId } });
    return {
      name: org.name,
      legalName: org.legalName,
      email: org.email,
      phone: org.phone,
      website: org.website,
      addressLines: this.addressLines(org),
      taxNumber: org.taxNumber,
      // Remote images are blocked during render; a logo must already be a data
      // URI. Wiring real logo storage is a later ticket.
      logoDataUri: org.logoUrl?.startsWith('data:') ? org.logoUrl : null,
    };
  }

  private customerBlock(customer: {
    companyName: string | null;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    taxNumber: string | null;
    billingAddressLine1: string | null;
    billingAddressLine2: string | null;
    billingCity: string | null;
    billingState: string | null;
    billingPostalCode: string | null;
    billingCountryCode: string | null;
  }) {
    return {
      name: customer.companyName || customer.contactName || 'Customer',
      email: customer.email,
      phone: customer.phone,
      taxNumber: customer.taxNumber,
      addressLines: this.addressLines({
        addressLine1: customer.billingAddressLine1,
        addressLine2: customer.billingAddressLine2,
        city: customer.billingCity,
        state: customer.billingState,
        postalCode: customer.billingPostalCode,
        countryCode: customer.billingCountryCode,
      }),
    };
  }

  private async loadQuotation(
    tx: TenantClient,
    organisationId: string,
    quotationId: string,
  ): Promise<TemplateData> {
    const quotation = await tx.quotation.findFirst({
      where: { id: quotationId, organisationId },
      include: { items: { orderBy: { position: 'asc' } }, customer: true },
    });
    if (!quotation) {
      throw notFound('QUOTATION_NOT_FOUND', `Quotation ${quotationId} not in org`);
    }

    return {
      kind: 'QUOTATION',
      documentNumber: quotation.quotationNumber,
      status: quotation.status,
      organisation: await this.loadOrganisation(tx, organisationId),
      customer: this.customerBlock(quotation.customer),
      dates: {
        issueLabel: 'Quotation date',
        issueDate: this.formatDate(quotation.issueDate),
        secondaryLabel: quotation.validUntil ? 'Valid until' : null,
        secondaryDate: quotation.validUntil ? this.formatDate(quotation.validUntil) : null,
      },
      currency: quotation.currencyCode,
      items: this.toTemplateItems(quotation.items),
      totals: {
        subtotal: quotation.subtotal.toFixed(4),
        discountAmount: quotation.discountAmount.toFixed(4),
        taxAmount: quotation.taxAmount.toFixed(4),
        totalAmount: quotation.totalAmount.toFixed(4),
      },
      notes: quotation.notes,
      terms: quotation.terms,
      generatedAt: this.formatDate(new Date()),
    };
  }

  private async loadInvoice(
    tx: TenantClient,
    organisationId: string,
    invoiceId: string,
  ): Promise<TemplateData> {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, organisationId },
      include: { items: { orderBy: { position: 'asc' } }, customer: true },
    });
    if (!invoice) {
      throw notFound('INVOICE_NOT_FOUND', `Invoice ${invoiceId} not in org`);
    }

    return {
      kind: 'INVOICE',
      documentNumber: invoice.invoiceNumber,
      status: invoice.status,
      organisation: await this.loadOrganisation(tx, organisationId),
      customer: this.customerBlock(invoice.customer),
      dates: {
        issueLabel: 'Invoice date',
        issueDate: this.formatDate(invoice.issueDate),
        secondaryLabel: 'Due date',
        secondaryDate: this.formatDate(invoice.dueDate),
      },
      currency: invoice.currencyCode,
      items: this.toTemplateItems(invoice.items),
      totals: {
        subtotal: invoice.subtotal.toFixed(4),
        discountAmount: invoice.discountAmount.toFixed(4),
        taxAmount: invoice.taxAmount.toFixed(4),
        totalAmount: invoice.totalAmount.toFixed(4),
        amountPaid: invoice.amountPaid.toFixed(4),
        amountDue: invoice.amountDue.toFixed(4),
      },
      paymentMethod: invoice.paymentMethod ? PAYMENT_METHOD_LABELS[invoice.paymentMethod] : null,
      dispatchedThrough: invoice.dispatchedThrough,
      notes: invoice.notes,
      terms: invoice.terms,
      generatedAt: this.formatDate(new Date()),
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.browser?.close();
  }
}
