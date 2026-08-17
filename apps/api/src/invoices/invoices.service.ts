import { Injectable, Inject } from '@nestjs/common';
import { withTenant, nextDocumentNumber, Prisma, type TenantClient } from '@billing/database';
import {
  calculateDocument,
  CalculationError,
  type CreateInvoiceInput,
  type UpdateInvoiceInput,
  type InvoiceListQuery,
} from '@billing/validation';
import {
  canTransitionInvoice,
  isEditableInvoiceStatus,
  checkScopedPermission,
  type OrganisationContext,
  type Paginated,
  type InvoiceStatus,
  type AuditAction,
} from '@billing/types';
import { AuditService } from '../common/audit/audit.service.js';
import { PdfService } from '../documents/pdf.service.js';
import { deductForInvoice, restoreForInvoice } from '../stock/stock-deduction.js';
import { notFound, conflict, validationFailed, forbidden } from '../common/errors/app-error.js';
import type { AuditMeta } from '../customers/customers.service.js';

/**
 * Invoice domain logic (TICKET-023 … TICKET-030).
 *
 * Mirrors the quotation service, with the differences that matter for money:
 *   - Cancellation replaces deletion and always records a reason.
 *   - BILLING may only cancel before payment (scoped permission).
 *   - amountPaid / amountDue are stored, maintained by the payment
 *     transaction, and never recomputed on read.
 */

const INVOICE_SELECT = {
  id: true,
  organisationId: true,
  customerId: true,
  quotationId: true,
  invoiceNumber: true,
  issueDate: true,
  dueDate: true,
  status: true,
  currencyCode: true,
  subtotal: true,
  discountAmount: true,
  taxAmount: true,
  totalAmount: true,
  amountPaid: true,
  amountDue: true,
  notes: true,
  terms: true,
  createdBy: true,
  sentAt: true,
  paidAt: true,
  cancelledAt: true,
  cancelledReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.InvoiceSelect;

const ITEM_SELECT = {
  id: true,
  position: true,
  // Carried so a duplicate or a quotation->invoice conversion keeps the stock
  // link; without it a converted invoice would silently stop deducting stock.
  stockItemId: true,
  description: true,
  quantity: true,
  unit: true,
  unitPrice: true,
  discountRate: true,
  discountAmount: true,
  taxRate: true,
  taxAmount: true,
  lineTotal: true,
} satisfies Prisma.InvoiceItemSelect;

function rethrowCalculation(error: unknown): never {
  if (error instanceof CalculationError) {
    throw validationFailed([{ field: error.field, message: error.message }]);
  }
  throw error;
}

const parseDate = (value: string) => new Date(`${value}T00:00:00.000Z`);

/** Today at UTC midnight — the reference point for overdue comparisons. */
function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

@Injectable()
export class InvoicesService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PdfService) private readonly pdf: PdfService,
  ) {}

  // -------------------------------------------------------------------------
  // TICKET-023 — list
  // -------------------------------------------------------------------------

  async list(org: OrganisationContext, query: InvoiceListQuery): Promise<Paginated<unknown>> {
    return withTenant(org.organisationId, async (tx) => {
      // Scoped to the active company as well as the organisation: each company
      // keeps its own customers, documents and financial position. The
      // organisation_id filter stays — it is the security boundary; company is
      // the view filter layered on top.
      const where: Prisma.InvoiceWhereInput = {
        organisationId: org.organisationId,
        companyId: org.companyId,
      };

      if (query.status) where.status = query.status;
      if (query.customerId) where.customerId = query.customerId;

      if (query.outstanding === 'true') {
        // Anything still collectable: issued, not settled, not withdrawn.
        where.status = { in: ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] };
        where.amountDue = { gt: 0 };
      }

      if (query.dateFrom || query.dateTo) {
        where.issueDate = {
          ...(query.dateFrom && { gte: parseDate(query.dateFrom) }),
          ...(query.dateTo && { lte: parseDate(query.dateTo) }),
        };
      }

      if (query.search) {
        const contains = { contains: query.search, mode: 'insensitive' as const };
        where.OR = [
          { invoiceNumber: contains },
          { customer: { companyName: contains } },
          { customer: { contactName: contains } },
        ];
      }

      const orderBy: Prisma.InvoiceOrderByWithRelationInput =
        query.sort === 'invoiceNumber'
          ? { invoiceNumber: query.direction }
          : query.sort === 'totalAmount'
            ? { totalAmount: query.direction }
            : query.sort === 'amountDue'
              ? { amountDue: query.direction }
              : query.sort === 'dueDate'
                ? { dueDate: query.direction }
                : { issueDate: query.direction };

      const [items, total] = await Promise.all([
        tx.invoice.findMany({
          where,
          select: {
            ...INVOICE_SELECT,
            customer: { select: { id: true, companyName: true, contactName: true } },
          },
          orderBy,
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        tx.invoice.count({ where }),
      ]);

      return {
        items,
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      };
    });
  }

  async findOne(org: OrganisationContext, invoiceId: string) {
    const invoice = await withTenant(org.organisationId, (tx) =>
      tx.invoice.findFirst({
        where: { id: invoiceId, organisationId: org.organisationId },
        select: {
          ...INVOICE_SELECT,
          items: { select: ITEM_SELECT, orderBy: { position: 'asc' } },
          customer: true,
          quotation: { select: { id: true, quotationNumber: true } },
          allocations: {
            select: {
              id: true,
              allocatedAmount: true,
              createdAt: true,
              payment: {
                select: {
                  id: true,
                  paymentNumber: true,
                  paymentDate: true,
                  paymentMethod: true,
                  reference: true,
                  status: true,
                },
              },
            },
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
    );

    if (!invoice) throw notFound('INVOICE_NOT_FOUND', `Invoice ${invoiceId} not in org`);
    return invoice;
  }

  // -------------------------------------------------------------------------
  // TICKET-024 / TICKET-025 / TICKET-026 — create
  // -------------------------------------------------------------------------

  async create(org: OrganisationContext, input: CreateInvoiceInput, meta: AuditMeta) {
    let totals;
    try {
      totals = calculateDocument(input.items, input.discount ?? undefined);
    } catch (error) {
      rethrowCalculation(error);
    }

    return withTenant(
      org.organisationId,
      async (tx) => {
        const customer = await this.requireActiveCustomer(tx, org.organisationId, input.customerId);

        const [organisation, settings] = await Promise.all([
          tx.organisation.findUniqueOrThrow({
            where: { id: org.organisationId },
            select: { currencyCode: true },
          }),
          tx.organisationSettings.findUnique({
            where: { organisationId: org.organisationId },
            select: { defaultPaymentTermsDays: true, defaultTerms: true },
          }),
        ]);

        const issueDate = parseDate(input.issueDate);
        const dueDate = input.dueDate
          ? parseDate(input.dueDate)
          : new Date(issueDate.getTime() + (settings?.defaultPaymentTermsDays ?? 30) * 86_400_000);

        if (dueDate < issueDate) {
          throw validationFailed([
            { field: 'dueDate', message: 'Due date must be on or after the invoice date' },
          ]);
        }

        // Reserved inside this transaction; rolls back with it (TICKET-026).
        const number = await nextDocumentNumber(tx, org.organisationId, org.companyId, 'INVOICE');

        const invoice = await tx.invoice.create({
          data: {
            organisationId: org.organisationId,
            companyId: org.companyId,
            customerId: customer.id,
            invoiceNumber: number.formatted,
            issueDate,
            dueDate,
            status: 'DRAFT',
            currencyCode: organisation.currencyCode,
            subtotal: totals.subtotal,
            discountAmount: totals.discountAmount,
            taxAmount: totals.taxAmount,
            totalAmount: totals.totalAmount,
            amountPaid: '0',
            // Nothing paid yet, so the full total is outstanding.
            amountDue: totals.totalAmount,
            notes: input.notes ?? null,
            terms: input.terms ?? settings?.defaultTerms ?? null,
            createdBy: meta.userId,
            items: {
              create: totals.items.map((item) => ({
                position: item.position,
                stockItemId: item.stockItemId,
                description: item.description,
                quantity: item.quantity,
                unit: item.unit,
                unitPrice: item.unitPrice,
                discountRate: item.discountRate,
                discountAmount: item.discountAmount,
                taxRate: item.taxRate,
                taxAmount: item.taxAmount,
                lineTotal: item.lineTotal,
              })),
            },
          },
          select: {
            ...INVOICE_SELECT,
            items: { select: ITEM_SELECT, orderBy: { position: 'asc' } },
          },
        });

        await this.audit.record(tx, {
          organisationId: org.organisationId,
          userId: meta.userId,
          action: 'INVOICE_CREATED',
          entityType: 'invoice',
          entityId: invoice.id,
          newValues: {
            invoiceNumber: invoice.invoiceNumber,
            customerId: customer.id,
            totalAmount: totals.totalAmount,
            itemCount: totals.items.length,
          },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });

        return invoice;
      },
      undefined,
      { userId: meta.userId },
    );
  }

  // -------------------------------------------------------------------------
  // TICKET-027 — draft editing
  // -------------------------------------------------------------------------

  async update(
    org: OrganisationContext,
    invoiceId: string,
    input: UpdateInvoiceInput,
    meta: AuditMeta,
  ) {
    return withTenant(
      org.organisationId,
      async (tx) => {
        const existing = await tx.invoice.findFirst({
          where: { id: invoiceId, organisationId: org.organisationId },
          select: {
            ...INVOICE_SELECT,
            items: { select: ITEM_SELECT, orderBy: { position: 'asc' } },
          },
        });
        if (!existing) throw notFound('INVOICE_NOT_FOUND', `Invoice ${invoiceId} not in org`);

        // Only DRAFT is editable. Once issued, the customer holds a copy and
        // the figures are a claim on them (Security Doc §17).
        if (!isEditableInvoiceStatus(existing.status as InvoiceStatus)) {
          throw conflict(
            'INVALID_STATUS_TRANSITION',
            `Invoice ${existing.invoiceNumber} is ${existing.status} and cannot be edited`,
          );
        }

        if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
          throw conflict(
            'STALE_RECORD',
            `Invoice ${invoiceId} is at version ${existing.version}, client sent ${input.expectedVersion}`,
          );
        }

        if (input.customerId && input.customerId !== existing.customerId) {
          await this.requireActiveCustomer(tx, org.organisationId, input.customerId);
        }

        const itemsForCalc =
          input.items ??
          existing.items.map((item) => ({
            description: item.description,
            quantity: item.quantity.toString(),
            unit: item.unit,
            unitPrice: item.unitPrice.toString(),
            discountAmount: item.discountAmount.toString(),
            taxRate: item.taxRate.toString(),
          }));

        const discountForCalc =
          input.discount !== undefined
            ? (input.discount ?? undefined)
            : existing.discountAmount.greaterThan(0)
              ? { amount: existing.discountAmount.toString() }
              : undefined;

        let totals;
        try {
          totals = calculateDocument(itemsForCalc, discountForCalc);
        } catch (error) {
          rethrowCalculation(error);
        }

        const issueDate = input.issueDate ? parseDate(input.issueDate) : existing.issueDate;
        const dueDate =
          input.dueDate === undefined
            ? existing.dueDate
            : input.dueDate
              ? parseDate(input.dueDate)
              : existing.dueDate;

        if (dueDate < issueDate) {
          throw validationFailed([
            { field: 'dueDate', message: 'Due date must be on or after the invoice date' },
          ]);
        }

        const invoice = await tx.invoice.update({
          where: { id: invoiceId },
          data: {
            ...(input.customerId && { customerId: input.customerId }),
            issueDate,
            dueDate,
            ...(input.notes !== undefined && { notes: input.notes }),
            ...(input.terms !== undefined && { terms: input.terms }),
            subtotal: totals.subtotal,
            discountAmount: totals.discountAmount,
            taxAmount: totals.taxAmount,
            totalAmount: totals.totalAmount,
            // A draft has no payments, so the balance follows the new total.
            amountDue: totals.totalAmount,
            version: { increment: 1 },
            ...(input.items && {
              items: {
                deleteMany: {},
                create: totals.items.map((item) => ({
                  position: item.position,
                  description: item.description,
                  quantity: item.quantity,
                  unit: item.unit,
                  unitPrice: item.unitPrice,
                  discountRate: item.discountRate,
                  discountAmount: item.discountAmount,
                  taxRate: item.taxRate,
                  taxAmount: item.taxAmount,
                  lineTotal: item.lineTotal,
                })),
              },
            }),
          },
          select: {
            ...INVOICE_SELECT,
            items: { select: ITEM_SELECT, orderBy: { position: 'asc' } },
          },
        });

        await this.audit.record(tx, {
          organisationId: org.organisationId,
          userId: meta.userId,
          action: 'INVOICE_UPDATED',
          entityType: 'invoice',
          entityId: invoiceId,
          oldValues: { totalAmount: existing.totalAmount.toString(), version: existing.version },
          newValues: { totalAmount: totals.totalAmount, version: invoice.version },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });

        return invoice;
      },
      undefined,
      { userId: meta.userId },
    );
  }

  // -------------------------------------------------------------------------
  // TICKET-028 — lifecycle
  // -------------------------------------------------------------------------

  /**
   * Send an invoice.
   *
   * The PDF renders inside this transaction, before the status moves — a
   * render failure rolls the whole thing back rather than marking an invoice
   * sent with nothing to send.
   */
  async send(org: OrganisationContext, invoiceId: string, meta: AuditMeta) {
    return withTenant(
      org.organisationId,
      async (tx) => {
        const existing = await tx.invoice.findFirst({
          where: { id: invoiceId, organisationId: org.organisationId },
          select: { id: true, status: true, invoiceNumber: true, totalAmount: true },
        });
        if (!existing) throw notFound('INVOICE_NOT_FOUND', `Invoice ${invoiceId} not in org`);

        const from = existing.status as InvoiceStatus;
        if (!canTransitionInvoice(from, 'SENT')) {
          throw conflict(
            'INVALID_STATUS_TRANSITION',
            `Cannot send invoice ${existing.invoiceNumber} from ${from}`,
          );
        }

        // A zero-value invoice is almost always a data error, and sending one
        // asks a customer to pay nothing. Blocked rather than silently issued.
        if (existing.totalAmount.lessThanOrEqualTo(0)) {
          throw conflict(
            'INVALID_STATUS_TRANSITION',
            'An invoice with a zero total cannot be sent',
          );
        }

        // Commit the goods before issuing the document. Inside the same
        // transaction, so an insufficient-stock failure rolls the send back
        // rather than leaving an issued invoice for stock nobody has.
        await deductForInvoice(tx, org.organisationId, org.companyId, invoiceId, meta.userId);

        await this.pdf.generate(org, 'invoices', invoiceId, { userId: meta.userId, tx });

        const invoice = await tx.invoice.update({
          where: { id: invoiceId },
          data: { status: 'SENT', sentAt: new Date(), version: { increment: 1 } },
          select: INVOICE_SELECT,
        });

        await this.audit.record(tx, {
          organisationId: org.organisationId,
          userId: meta.userId,
          action: 'INVOICE_SENT',
          entityType: 'invoice',
          entityId: invoiceId,
          oldValues: { status: from },
          newValues: { status: 'SENT' },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });

        return invoice;
      },
      undefined,
      { userId: meta.userId },
    );
  }

  /**
   * Cancel an invoice (TICKET-028).
   *
   * Cancellation is the only withdrawal path — issued invoices are never
   * deleted, and the number is retained so the sequence stays unbroken
   * (Security Doc §41 rule 6).
   *
   * This is the first endpoint to use `checkScopedPermission`. BILLING holds
   * `invoice:cancel` as a base permission but may only exercise it on DRAFT or
   * SENT invoices; once money has been received, withdrawing the invoice
   * rewrites settled history and is reserved for OWNER/ADMIN (Security §12).
   */
  async cancel(org: OrganisationContext, invoiceId: string, reason: string, meta: AuditMeta) {
    return withTenant(
      org.organisationId,
      async (tx) => {
        const existing = await tx.invoice.findFirst({
          where: { id: invoiceId, organisationId: org.organisationId },
          select: {
            id: true,
            status: true,
            invoiceNumber: true,
            amountPaid: true,
          },
        });
        if (!existing) throw notFound('INVOICE_NOT_FOUND', `Invoice ${invoiceId} not in org`);

        const from = existing.status as InvoiceStatus;

        // Role check against this specific record, after loading it.
        const scoped = checkScopedPermission(org.role, {
          permission: 'invoice:cancel',
          invoiceStatus: from,
        });
        if (!scoped.allowed) {
          throw forbidden(scoped.reason ?? 'Cancellation not permitted for this invoice');
        }

        if (!canTransitionInvoice(from, 'CANCELLED')) {
          throw conflict(
            'INVALID_STATUS_TRANSITION',
            `Cannot cancel invoice ${existing.invoiceNumber} from ${from}`,
          );
        }

        // Cancelling an invoice that holds payments would orphan that money.
        // The payments must be voided first, as an explicit decision.
        if (existing.amountPaid.greaterThan(0)) {
          throw conflict(
            'INVALID_STATUS_TRANSITION',
            `Invoice ${existing.invoiceNumber} has recorded payments; void them before cancelling`,
          );
        }

        // Goods committed by this invoice go back on the shelf. Recorded as
        // new IN movements, never by deleting the OUT rows — the movement
        // ledger is append-only and the round trip is what an auditor reads.
        await restoreForInvoice(tx, org.organisationId, org.companyId, invoiceId, meta.userId);

        const invoice = await tx.invoice.update({
          where: { id: invoiceId },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledReason: reason,
            // Nothing is collectable on a cancelled invoice.
            amountDue: '0',
            version: { increment: 1 },
          },
          select: INVOICE_SELECT,
        });

        await this.audit.record(tx, {
          organisationId: org.organisationId,
          userId: meta.userId,
          action: 'INVOICE_CANCELLED',
          entityType: 'invoice',
          entityId: invoiceId,
          oldValues: { status: from },
          newValues: { status: 'CANCELLED', reason },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });

        return invoice;
      },
      undefined,
      { userId: meta.userId },
    );
  }

  /**
   * Mark past-due invoices as OVERDUE (TICKET-035).
   *
   * Comparison is on date-only values in UTC, so the result does not shift
   * with server timezone. Only SENT and PARTIALLY_PAID qualify: a draft was
   * never issued, and PAID/CANCELLED are settled. `amountDue > 0` is required
   * so a fully-paid invoice can never be flagged overdue.
   *
   * Idempotent — safe to run on a schedule.
   */
  async markOverdue(org: OrganisationContext, asOf: Date = todayUtc()): Promise<number> {
    return withTenant(org.organisationId, async (tx) => {
      const result = await tx.invoice.updateMany({
        where: {
          organisationId: org.organisationId,
          status: { in: ['SENT', 'PARTIALLY_PAID'] },
          dueDate: { lt: asOf },
          amountDue: { gt: 0 },
        },
        data: { status: 'OVERDUE' },
      });
      return result.count;
    });
  }

  // -------------------------------------------------------------------------
  // TICKET-030 — duplicate
  // -------------------------------------------------------------------------

  async duplicate(org: OrganisationContext, invoiceId: string, meta: AuditMeta) {
    return withTenant(
      org.organisationId,
      async (tx) => {
        const source = await tx.invoice.findFirst({
          where: { id: invoiceId, organisationId: org.organisationId },
          select: {
            ...INVOICE_SELECT,
            items: { select: ITEM_SELECT, orderBy: { position: 'asc' } },
          },
        });
        if (!source) throw notFound('INVOICE_NOT_FOUND', `Invoice ${invoiceId} not in org`);

        await this.requireActiveCustomer(tx, org.organisationId, source.customerId);

        const number = await nextDocumentNumber(tx, org.organisationId, org.companyId, 'INVOICE');

        // Dates reset to today: a duplicate is a new claim, and carrying the
        // original issue date would misstate when it was raised.
        const issueDate = todayUtc();
        const termDays = Math.max(
          0,
          Math.round((source.dueDate.getTime() - source.issueDate.getTime()) / 86_400_000),
        );
        const dueDate = new Date(issueDate.getTime() + termDays * 86_400_000);

        const copy = await tx.invoice.create({
          data: {
            organisationId: org.organisationId,
            companyId: org.companyId,
            customerId: source.customerId,
            // The source quotation link is NOT copied: this invoice did not
            // come from that quotation, and duplicating the link would imply
            // one quotation produced two invoices (TICKET-030 acceptance).
            quotationId: null,
            invoiceNumber: number.formatted,
            issueDate,
            dueDate,
            status: 'DRAFT',
            currencyCode: source.currencyCode,
            subtotal: source.subtotal,
            discountAmount: source.discountAmount,
            taxAmount: source.taxAmount,
            totalAmount: source.totalAmount,
            // Payment history is never copied.
            amountPaid: '0',
            amountDue: source.totalAmount,
            notes: source.notes,
            terms: source.terms,
            createdBy: meta.userId,
            items: {
              create: source.items.map((item) => ({
                position: item.position,
                stockItemId: item.stockItemId,
                description: item.description,
                quantity: item.quantity,
                unit: item.unit,
                unitPrice: item.unitPrice,
                discountRate: item.discountRate,
                discountAmount: item.discountAmount,
                taxRate: item.taxRate,
                taxAmount: item.taxAmount,
                lineTotal: item.lineTotal,
              })),
            },
          },
          select: {
            ...INVOICE_SELECT,
            items: { select: ITEM_SELECT, orderBy: { position: 'asc' } },
          },
        });

        await this.audit.record(tx, {
          organisationId: org.organisationId,
          userId: meta.userId,
          action: 'INVOICE_DUPLICATED',
          entityType: 'invoice',
          entityId: copy.id,
          newValues: {
            invoiceNumber: copy.invoiceNumber,
            duplicatedFrom: source.invoiceNumber,
          },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });

        return copy;
      },
      undefined,
      { userId: meta.userId },
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async requireActiveCustomer(
    tx: TenantClient,
    organisationId: string,
    customerId: string,
  ) {
    const customer = await tx.customer.findFirst({
      where: { id: customerId, organisationId },
      select: { id: true, isArchived: true },
    });

    if (!customer) {
      throw notFound('CUSTOMER_NOT_FOUND', `Customer ${customerId} not in org ${organisationId}`);
    }
    if (customer.isArchived) {
      throw conflict(
        'INVALID_STATUS_TRANSITION',
        'This customer is archived. Restore them before creating documents.',
      );
    }
    return customer;
  }
}
