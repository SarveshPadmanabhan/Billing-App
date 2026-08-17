import { Injectable, Inject } from '@nestjs/common';
import {
  withTenant,
  nextDocumentNumber,
  Prisma,
  type TenantClient,
} from '@billing/database';
import {
  calculateDocument,
  CalculationError,
  type CreateQuotationInput,
  type UpdateQuotationInput,
  type QuotationListQuery,
} from '@billing/validation';
import {
  canTransitionQuotation,
  isEditableQuotationStatus,
  type OrganisationContext,
  type Paginated,
  type QuotationStatus,
  type AuditAction,
} from '@billing/types';
import { AuditService } from '../common/audit/audit.service.js';
import { PdfService } from '../documents/pdf.service.js';
import { notFound, conflict, validationFailed, forbidden } from '../common/errors/app-error.js';
import type { AuditMeta } from '../customers/customers.service.js';

/**
 * Quotation domain logic (TICKET-014 … TICKET-022).
 *
 * Invariants enforced here rather than trusted from the client:
 *   - Totals are always recomputed from line items.
 *   - The number comes from the document sequence, inside the same
 *     transaction as the insert, and never changes afterwards.
 *   - Only DRAFT quotations are editable; every other change is an explicit
 *     lifecycle transition.
 *   - Conversion is idempotent and guarded by a row lock.
 */

const QUOTATION_SELECT = {
  id: true,
  organisationId: true,
  customerId: true,
  quotationNumber: true,
  issueDate: true,
  validUntil: true,
  status: true,
  currencyCode: true,
  subtotal: true,
  discountAmount: true,
  taxAmount: true,
  totalAmount: true,
  notes: true,
  terms: true,
  createdBy: true,
  sentAt: true,
  acceptedAt: true,
  rejectedAt: true,
  convertedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.QuotationSelect;

const ITEM_SELECT = {
  id: true,
  position: true,
  description: true,
  quantity: true,
  unit: true,
  unitPrice: true,
  discountRate: true,
  discountAmount: true,
  taxRate: true,
  taxAmount: true,
  lineTotal: true,
} satisfies Prisma.QuotationItemSelect;

/** Convert a CalculationError into a field-level validation response. */
function rethrowCalculation(error: unknown): never {
  if (error instanceof CalculationError) {
    throw validationFailed([{ field: error.field, message: error.message }]);
  }
  throw error;
}

/** Parse a YYYY-MM-DD string as a UTC date, avoiding local-timezone drift. */
const parseDate = (value: string) => new Date(`${value}T00:00:00.000Z`);

@Injectable()
export class QuotationsService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PdfService) private readonly pdf: PdfService,
  ) {}

  // -------------------------------------------------------------------------
  // TICKET-014 — list
  // -------------------------------------------------------------------------

  async list(org: OrganisationContext, query: QuotationListQuery): Promise<Paginated<unknown>> {
    return withTenant(org.organisationId, async (tx) => {
      // Scoped to the active company as well as the organisation: each company
      // keeps its own customers, documents and financial position. The
      // organisation_id filter stays — it is the security boundary; company is
      // the view filter layered on top.
      const where: Prisma.QuotationWhereInput = {
        organisationId: org.organisationId,
        companyId: org.companyId,
      };

      if (query.status) where.status = query.status;
      if (query.customerId) where.customerId = query.customerId;

      if (query.dateFrom || query.dateTo) {
        where.issueDate = {
          ...(query.dateFrom && { gte: parseDate(query.dateFrom) }),
          ...(query.dateTo && { lte: parseDate(query.dateTo) }),
        };
      }

      if (query.search) {
        const contains = { contains: query.search, mode: 'insensitive' as const };
        where.OR = [
          { quotationNumber: contains },
          { customer: { companyName: contains } },
          { customer: { contactName: contains } },
        ];
      }

      const orderBy: Prisma.QuotationOrderByWithRelationInput =
        query.sort === 'quotationNumber'
          ? { quotationNumber: query.direction }
          : query.sort === 'totalAmount'
            ? { totalAmount: query.direction }
            : { issueDate: query.direction };

      const [items, total] = await Promise.all([
        tx.quotation.findMany({
          where,
          select: {
            ...QUOTATION_SELECT,
            customer: { select: { id: true, companyName: true, contactName: true } },
          },
          orderBy,
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        tx.quotation.count({ where }),
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

  async findOne(org: OrganisationContext, quotationId: string) {
    const quotation = await withTenant(org.organisationId, (tx) =>
      tx.quotation.findFirst({
        where: { id: quotationId, organisationId: org.organisationId },
        select: {
          ...QUOTATION_SELECT,
          items: { select: ITEM_SELECT, orderBy: { position: 'asc' } },
          customer: true,
          invoices: { select: { id: true, invoiceNumber: true, status: true } },
        },
      }),
    );

    if (!quotation) {
      throw notFound('QUOTATION_NOT_FOUND', `Quotation ${quotationId} not in org`);
    }
    return quotation;
  }

  // -------------------------------------------------------------------------
  // TICKET-016 / TICKET-017 — create
  // -------------------------------------------------------------------------

  async create(org: OrganisationContext, input: CreateQuotationInput, meta: AuditMeta) {
    // Totals computed before opening the transaction: invalid input should not
    // consume a document number.
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
        const organisation = await tx.organisation.findUniqueOrThrow({
          where: { id: org.organisationId },
          select: { currencyCode: true },
        });

        // Reserved inside this transaction; rolls back with it if anything
        // below fails, keeping numbering gapless (TICKET-015).
        const number = await nextDocumentNumber(tx, org.organisationId, org.companyId, 'QUOTATION');

        const quotation = await tx.quotation.create({
          data: {
            organisationId: org.organisationId,
            companyId: org.companyId,
            customerId: customer.id,
            quotationNumber: number.formatted,
            issueDate: parseDate(input.issueDate),
            validUntil: input.validUntil ? parseDate(input.validUntil) : null,
            status: 'DRAFT',
            currencyCode: organisation.currencyCode,
            subtotal: totals.subtotal,
            discountAmount: totals.discountAmount,
            taxAmount: totals.taxAmount,
            totalAmount: totals.totalAmount,
            notes: input.notes ?? null,
            terms: input.terms ?? null,
            createdBy: meta.userId,
            items: {
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
          },
          select: {
            ...QUOTATION_SELECT,
            items: { select: ITEM_SELECT, orderBy: { position: 'asc' } },
          },
        });

        await this.audit.record(tx, {
          organisationId: org.organisationId,
          userId: meta.userId,
          action: 'QUOTATION_CREATED',
          entityType: 'quotation',
          entityId: quotation.id,
          newValues: {
            quotationNumber: quotation.quotationNumber,
            customerId: customer.id,
            totalAmount: totals.totalAmount,
            itemCount: totals.items.length,
          },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });

        return quotation;
      },
      undefined,
      { userId: meta.userId },
    );
  }

  // -------------------------------------------------------------------------
  // TICKET-018 — draft editing
  // -------------------------------------------------------------------------

  async update(
    org: OrganisationContext,
    quotationId: string,
    input: UpdateQuotationInput,
    meta: AuditMeta,
  ) {
    return withTenant(
      org.organisationId,
      async (tx) => {
        const existing = await tx.quotation.findFirst({
          where: { id: quotationId, organisationId: org.organisationId },
          select: {
            ...QUOTATION_SELECT,
            items: { select: ITEM_SELECT, orderBy: { position: 'asc' } },
          },
        });
        if (!existing) throw notFound('QUOTATION_NOT_FOUND', `Quotation ${quotationId} not in org`);

        // Only DRAFT is editable. A SENT quotation the customer has already
        // seen must not change under them (Security Doc §18).
        if (!isEditableQuotationStatus(existing.status as QuotationStatus)) {
          throw conflict(
            'INVALID_STATUS_TRANSITION',
            `Quotation ${existing.quotationNumber} is ${existing.status} and cannot be edited`,
          );
        }

        if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
          throw conflict(
            'STALE_RECORD',
            `Quotation ${quotationId} is at version ${existing.version}, client sent ${input.expectedVersion}`,
          );
        }

        if (input.customerId && input.customerId !== existing.customerId) {
          await this.requireActiveCustomer(tx, org.organisationId, input.customerId);
        }

        // Recompute whenever items or the document discount change. Passing
        // stored items back through the engine keeps one code path.
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
        const validUntil =
          input.validUntil === undefined
            ? existing.validUntil
            : input.validUntil
              ? parseDate(input.validUntil)
              : null;

        if (validUntil && validUntil < issueDate) {
          throw validationFailed([
            { field: 'validUntil', message: 'Valid-until date must be on or after the issue date' },
          ]);
        }

        const quotation = await tx.quotation.update({
          where: { id: quotationId },
          data: {
            ...(input.customerId && { customerId: input.customerId }),
            issueDate,
            validUntil,
            ...(input.notes !== undefined && { notes: input.notes }),
            ...(input.terms !== undefined && { terms: input.terms }),
            subtotal: totals.subtotal,
            discountAmount: totals.discountAmount,
            taxAmount: totals.taxAmount,
            totalAmount: totals.totalAmount,
            // The number never changes on edit (TICKET-018 acceptance).
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
            ...QUOTATION_SELECT,
            items: { select: ITEM_SELECT, orderBy: { position: 'asc' } },
          },
        });

        await this.audit.record(tx, {
          organisationId: org.organisationId,
          userId: meta.userId,
          action: 'QUOTATION_UPDATED',
          entityType: 'quotation',
          entityId: quotationId,
          oldValues: { totalAmount: existing.totalAmount.toString(), version: existing.version },
          newValues: { totalAmount: totals.totalAmount, version: quotation.version },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });

        return quotation;
      },
      undefined,
      { userId: meta.userId },
    );
  }

  // -------------------------------------------------------------------------
  // TICKET-019 — lifecycle
  // -------------------------------------------------------------------------

  /**
   * Apply a status transition.
   *
   * Every transition goes through `canTransitionQuotation`, so an invalid or
   * backward move is rejected in one place rather than per endpoint.
   */
  private async transition(
    org: OrganisationContext,
    quotationId: string,
    to: QuotationStatus,
    meta: AuditMeta,
    options: {
      action: AuditAction;
      reason?: string | null;
      timestampField?: 'sentAt' | 'acceptedAt' | 'rejectedAt';
      /**
       * Runs inside the transaction BEFORE the status is written. Throwing
       * here rolls the whole transition back, which is how send guarantees it
       * never marks a document sent without a renderable PDF.
       */
      beforeCommit?: (tx: TenantClient) => Promise<void>;
    },
  ) {
    return withTenant(
      org.organisationId,
      async (tx) => {
        const existing = await tx.quotation.findFirst({
          where: { id: quotationId, organisationId: org.organisationId },
          select: { id: true, status: true, quotationNumber: true, validUntil: true },
        });
        if (!existing) throw notFound('QUOTATION_NOT_FOUND', `Quotation ${quotationId} not in org`);

        const from = existing.status as QuotationStatus;
        if (!canTransitionQuotation(from, to)) {
          throw conflict(
            'INVALID_STATUS_TRANSITION',
            `Cannot move quotation ${existing.quotationNumber} from ${from} to ${to}`,
          );
        }

        await options.beforeCommit?.(tx);

        const quotation = await tx.quotation.update({
          where: { id: quotationId },
          data: {
            status: to,
            version: { increment: 1 },
            ...(options.timestampField && { [options.timestampField]: new Date() }),
          },
          select: QUOTATION_SELECT,
        });

        await this.audit.record(tx, {
          organisationId: org.organisationId,
          userId: meta.userId,
          action: options.action,
          entityType: 'quotation',
          entityId: quotationId,
          oldValues: { status: from },
          newValues: { status: to, ...(options.reason ? { reason: options.reason } : {}) },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });

        return quotation;
      },
      undefined,
      { userId: meta.userId },
    );
  }

  /**
   * Send a quotation.
   *
   * The PDF is rendered inside the same transaction, before the status moves.
   * If Playwright fails, the transaction rolls back: the quotation stays
   * DRAFT, no sentAt is written, and no audit row claims it was sent. The
   * alternative — flip status, then render — can leave a quotation marked SENT
   * with nothing to send (Security Doc §23).
   */
  send(org: OrganisationContext, id: string, meta: AuditMeta) {
    return this.transition(org, id, 'SENT', meta, {
      action: 'QUOTATION_SENT',
      timestampField: 'sentAt',
      beforeCommit: async (tx) => {
        await this.pdf.generate(org, 'quotations', id, { userId: meta.userId, tx });
      },
    });
  }

  accept(org: OrganisationContext, id: string, meta: AuditMeta) {
    return this.transition(org, id, 'ACCEPTED', meta, {
      action: 'QUOTATION_ACCEPTED',
      timestampField: 'acceptedAt',
    });
  }

  reject(org: OrganisationContext, id: string, reason: string | null, meta: AuditMeta) {
    return this.transition(org, id, 'REJECTED', meta, {
      action: 'QUOTATION_REJECTED',
      timestampField: 'rejectedAt',
      reason,
    });
  }

  cancel(org: OrganisationContext, id: string, reason: string | null, meta: AuditMeta) {
    return this.transition(org, id, 'CANCELLED', meta, {
      action: 'QUOTATION_CANCELLED',
      reason,
    });
  }

  /**
   * Expire quotations past their valid-until date.
   *
   * Only SENT quotations expire: a DRAFT was never issued, and an ACCEPTED one
   * represents a commitment that outliving its quote date should not silently
   * revoke. Intended for a scheduled job; exposed for tests.
   */
  async expireOverdue(org: OrganisationContext, asOf = new Date()): Promise<number> {
    return withTenant(org.organisationId, async (tx) => {
      const result = await tx.quotation.updateMany({
        where: {
          organisationId: org.organisationId,
          status: 'SENT',
          validUntil: { not: null, lt: asOf },
        },
        data: { status: 'EXPIRED' },
      });
      return result.count;
    });
  }

  // -------------------------------------------------------------------------
  // TICKET-021 — duplicate
  // -------------------------------------------------------------------------

  async duplicate(org: OrganisationContext, quotationId: string, meta: AuditMeta) {
    return withTenant(
      org.organisationId,
      async (tx) => {
        const source = await tx.quotation.findFirst({
          where: { id: quotationId, organisationId: org.organisationId },
          select: {
            ...QUOTATION_SELECT,
            items: { select: ITEM_SELECT, orderBy: { position: 'asc' } },
          },
        });
        if (!source) throw notFound('QUOTATION_NOT_FOUND', `Quotation ${quotationId} not in org`);

        // The copy targets the same customer, so that customer must still be
        // active — duplicating onto an archived customer would create a
        // document nobody can act on.
        await this.requireActiveCustomer(tx, org.organisationId, source.customerId);

        const number = await nextDocumentNumber(tx, org.organisationId, org.companyId, 'QUOTATION');

        // Dates reset to today rather than copied: a duplicate is a new offer,
        // and carrying a stale issue date would misrepresent it.
        const today = new Date();
        const issueDate = new Date(
          Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
        );

        // Preserve the original validity window length, if it had one.
        let validUntil: Date | null = null;
        if (source.validUntil) {
          const windowDays = Math.round(
            (source.validUntil.getTime() - source.issueDate.getTime()) / 86_400_000,
          );
          validUntil = new Date(issueDate.getTime() + windowDays * 86_400_000);
        }

        const copy = await tx.quotation.create({
          data: {
            organisationId: org.organisationId,
            companyId: org.companyId,
            customerId: source.customerId,
            quotationNumber: number.formatted,
            issueDate,
            validUntil,
            status: 'DRAFT', // Always starts fresh (TICKET-021 acceptance).
            currencyCode: source.currencyCode,
            subtotal: source.subtotal,
            discountAmount: source.discountAmount,
            taxAmount: source.taxAmount,
            totalAmount: source.totalAmount,
            notes: source.notes,
            terms: source.terms,
            createdBy: meta.userId,
            items: {
              create: source.items.map((item) => ({
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
          },
          select: {
            ...QUOTATION_SELECT,
            items: { select: ITEM_SELECT, orderBy: { position: 'asc' } },
          },
        });

        await this.audit.record(tx, {
          organisationId: org.organisationId,
          userId: meta.userId,
          action: 'QUOTATION_DUPLICATED',
          entityType: 'quotation',
          entityId: copy.id,
          newValues: {
            quotationNumber: copy.quotationNumber,
            duplicatedFrom: source.quotationNumber,
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
  // TICKET-022 — quotation to invoice
  // -------------------------------------------------------------------------

  /**
   * Convert an ACCEPTED quotation into an invoice.
   *
   * Idempotency is structural rather than key-based. The quotation row is
   * locked FOR UPDATE, then its status is re-read inside the lock: a second
   * concurrent request blocks, wakes to find CONVERTED, and returns the
   * invoice the first request created. A retry after commit takes the same
   * path. There is therefore no window in which two invoices can be produced
   * from one quotation (Security Doc §18, Frontend Spec §19).
   *
   * ---------------------------------------------------------------------
   * DO NOT change the item copy below into a recalculation.
   *
   * This is a deliberate decision, not an oversight. The invoice must state
   * exactly the figures the customer accepted. If the organisation's default
   * tax rate, discount policy, or price list changes between acceptance and
   * conversion, recalculating would produce an invoice that silently differs
   * from the accepted quotation — a billing dispute, not merely a data
   * inconsistency. Amounts are therefore carried across as stored.
   *
   * If the figures genuinely need to change, the correct path is to issue a
   * new quotation and have the customer accept that instead.
   * ---------------------------------------------------------------------
   *
   * Line items are copied verbatim rather than recalculated: the customer
   * accepted specific figures, and a tax-rate change between acceptance and
   * conversion must not silently alter what they agreed to.
   */
  async convertToInvoice(
    org: OrganisationContext,
    quotationId: string,
    input: { issueDate?: string; dueDate?: string; notes?: string | null; terms?: string | null },
    meta: AuditMeta,
  ) {
    return withTenant(
      org.organisationId,
      async (tx) => {
        // Row lock first. Everything below runs while the quotation is held.
        const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
          SELECT id, status FROM quotations
           WHERE id = ${quotationId}::uuid
             AND organisation_id = ${org.organisationId}::uuid
           FOR UPDATE
        `;

        if (locked.length === 0) {
          throw notFound('QUOTATION_NOT_FOUND', `Quotation ${quotationId} not in org`);
        }

        const status = locked[0]!.status as QuotationStatus;

        // Already converted: return the existing invoice rather than erroring.
        // This is what makes a retry or double-click safe.
        if (status === 'CONVERTED') {
          const existingInvoice = await tx.invoice.findFirst({
            where: { organisationId: org.organisationId, quotationId },
            select: { id: true, invoiceNumber: true, status: true, totalAmount: true },
            orderBy: { createdAt: 'asc' },
          });

          if (existingInvoice) {
            return { invoice: existingInvoice, alreadyConverted: true as const };
          }
          // CONVERTED with no invoice means an earlier partial failure; the
          // transaction that set it should have rolled back. Surface it rather
          // than papering over an inconsistent state.
          throw conflict(
            'INVALID_STATUS_TRANSITION',
            `Quotation ${quotationId} is CONVERTED but has no invoice`,
          );
        }

        if (!canTransitionQuotation(status, 'CONVERTED')) {
          throw conflict(
            'INVALID_STATUS_TRANSITION',
            `Only accepted quotations can be converted; this one is ${status}`,
          );
        }

        const quotation = await tx.quotation.findUniqueOrThrow({
          where: { id: quotationId },
          select: {
            ...QUOTATION_SELECT,
            items: { select: ITEM_SELECT, orderBy: { position: 'asc' } },
          },
        });

        await this.requireActiveCustomer(tx, org.organisationId, quotation.customerId);

        const settings = await tx.organisationSettings.findUnique({
          where: { organisationId: org.organisationId },
          select: { defaultPaymentTermsDays: true, defaultTerms: true },
        });

        const issueDate = input.issueDate
          ? parseDate(input.issueDate)
          : new Date(
              Date.UTC(
                new Date().getUTCFullYear(),
                new Date().getUTCMonth(),
                new Date().getUTCDate(),
              ),
            );

        const dueDate = input.dueDate
          ? parseDate(input.dueDate)
          : new Date(issueDate.getTime() + (settings?.defaultPaymentTermsDays ?? 30) * 86_400_000);

        if (dueDate < issueDate) {
          throw validationFailed([
            { field: 'dueDate', message: 'Due date must be on or after the issue date' },
          ]);
        }

        const number = await nextDocumentNumber(tx, org.organisationId, org.companyId, 'INVOICE');

        const invoice = await tx.invoice.create({
          data: {
            organisationId: org.organisationId,
            companyId: org.companyId,
            customerId: quotation.customerId,
            quotationId: quotation.id, // Preserves the source relationship.
            invoiceNumber: number.formatted,
            issueDate,
            dueDate,
            status: 'DRAFT',
            currencyCode: quotation.currencyCode,
            subtotal: quotation.subtotal,
            discountAmount: quotation.discountAmount,
            taxAmount: quotation.taxAmount,
            totalAmount: quotation.totalAmount,
            amountPaid: '0',
            amountDue: quotation.totalAmount,
            notes: input.notes ?? quotation.notes,
            terms: input.terms ?? quotation.terms ?? settings?.defaultTerms ?? null,
            createdBy: meta.userId,
            items: {
              create: quotation.items.map((item) => ({
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
          },
          select: {
            id: true,
            invoiceNumber: true,
            status: true,
            totalAmount: true,
            amountDue: true,
            issueDate: true,
            dueDate: true,
          },
        });

        // The quotation is preserved, not replaced — only its status moves.
        await tx.quotation.update({
          where: { id: quotationId },
          data: { status: 'CONVERTED', convertedAt: new Date(), version: { increment: 1 } },
        });

        await this.audit.record(tx, {
          organisationId: org.organisationId,
          userId: meta.userId,
          action: 'QUOTATION_CONVERTED',
          entityType: 'quotation',
          entityId: quotationId,
          oldValues: { status },
          newValues: {
            status: 'CONVERTED',
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
          },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });

        await this.audit.record(tx, {
          organisationId: org.organisationId,
          userId: meta.userId,
          action: 'INVOICE_CREATED',
          entityType: 'invoice',
          entityId: invoice.id,
          newValues: {
            invoiceNumber: invoice.invoiceNumber,
            fromQuotation: quotation.quotationNumber,
            totalAmount: invoice.totalAmount.toString(),
          },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });

        return { invoice, alreadyConverted: false as const };
      },
      undefined,
      { userId: meta.userId },
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Load a customer, proving it belongs to this organisation and is active.
   *
   * Step 4 of the check chain: a customer id from the request body is never
   * trusted to be in-tenant just because the caller is authenticated.
   */
  private async requireActiveCustomer(
    tx: TenantClient,
    organisationId: string,
    customerId: string,
  ) {
    const customer = await tx.customer.findFirst({
      where: { id: customerId, organisationId },
      select: { id: true, isArchived: true, companyName: true, contactName: true },
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
