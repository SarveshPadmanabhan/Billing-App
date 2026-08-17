import { Injectable, Inject } from '@nestjs/common';
import { withTenant, Prisma, type TenantClient } from '@billing/database';
import { calculateBalance } from '@billing/validation';
import type {
  CreateCustomerInput,
  UpdateCustomerInput,
  CustomerListQuery,
} from '@billing/validation';
import type { OrganisationContext, Paginated } from '@billing/types';
import { AuditService } from '../common/audit/audit.service.js';
import { notFound, conflict, validationFailed } from '../common/errors/app-error.js';

/**
 * Customer domain logic (TICKET-009 to TICKET-013).
 *
 * Every method runs inside `withTenant`, so RLS applies on top of the explicit
 * `organisationId` filter. Nothing here accepts an organisation id from a
 * caller — it always comes from the verified `OrganisationContext`.
 */

export interface AuditMeta {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** Columns returned to clients. Excludes nothing sensitive, but is explicit. */
const CUSTOMER_SELECT = {
  id: true,
  organisationId: true,
  customerType: true,
  companyName: true,
  contactName: true,
  email: true,
  phone: true,
  taxNumber: true,
  billingAddressLine1: true,
  billingAddressLine2: true,
  billingCity: true,
  billingState: true,
  billingPostalCode: true,
  billingCountryCode: true,
  shippingAddressLine1: true,
  shippingAddressLine2: true,
  shippingCity: true,
  shippingState: true,
  shippingPostalCode: true,
  shippingCountryCode: true,
  notes: true,
  isArchived: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CustomerSelect;

@Injectable()
export class CustomersService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  // -------------------------------------------------------------------------
  // TICKET-009 / TICKET-012 — list and search
  // -------------------------------------------------------------------------

  async list(org: OrganisationContext, query: CustomerListQuery): Promise<Paginated<unknown>> {
    return withTenant(org.organisationId, async (tx) => {
      const where = this.buildWhere(org.organisationId, org.companyId, query);

      // Outstanding sorting needs an aggregate, so it takes a different path
      // from the plain column sorts.
      if (query.sort === 'outstanding') {
        return this.listByOutstanding(tx, org.organisationId, query, where);
      }

      const orderBy: Prisma.CustomerOrderByWithRelationInput =
        query.sort === 'companyName'
          ? { companyName: query.direction }
          : { createdAt: query.direction };

      const [rows, total] = await Promise.all([
        tx.customer.findMany({
          where,
          select: CUSTOMER_SELECT,
          orderBy,
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        tx.customer.count({ where }),
      ]);

      const outstanding = await this.outstandingFor(
        tx,
        org.organisationId,
        rows.map((r) => r.id),
      );

      return {
        items: rows.map((row) => ({ ...row, outstanding: outstanding.get(row.id) ?? '0.0000' })),
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      };
    });
  }

  private buildWhere(
    organisationId: string,
    companyId: string,
    query: CustomerListQuery,
  ): Prisma.CustomerWhereInput {
    // organisation_id is the security boundary; company_id narrows the view to
    // the entity the user has selected.
    const where: Prisma.CustomerWhereInput = { organisationId, companyId };

    // Archived customers leave the default list but remain reachable
    // (TICKET-011): their historical documents must stay viewable.
    if (query.status === 'active') where.isArchived = false;
    else if (query.status === 'archived') where.isArchived = true;

    if (query.search) {
      // Partial, case-insensitive across the four fields a user would search
      // by (TICKET-012). Prisma parameterises these, so no injection risk.
      const contains = { contains: query.search, mode: 'insensitive' as const };
      where.OR = [
        { companyName: contains },
        { contactName: contains },
        { email: contains },
        { phone: contains },
      ];
    }

    return where;
  }

  /**
   * Sort by outstanding balance.
   *
   * Outstanding is the sum of `amount_due` on live invoices, so it cannot be
   * ordered by a plain column. The aggregate runs in SQL rather than in
   * application code so pagination stays correct.
   */
  private async listByOutstanding(
    tx: TenantClient,
    organisationId: string,
    query: CustomerListQuery,
    where: Prisma.CustomerWhereInput,
  ): Promise<Paginated<unknown>> {
    const matching = await tx.customer.findMany({ where, select: { id: true } });
    const ids = matching.map((m) => m.id);

    if (ids.length === 0) {
      return { items: [], page: query.page, limit: query.limit, total: 0, totalPages: 1 };
    }

    const outstanding = await this.outstandingFor(tx, organisationId, ids);

    const ordered = [...ids].sort((a, b) => {
      const left = Number(outstanding.get(a) ?? 0);
      const right = Number(outstanding.get(b) ?? 0);
      return query.direction === 'asc' ? left - right : right - left;
    });

    const pageIds = ordered.slice((query.page - 1) * query.limit, query.page * query.limit);

    const rows = await tx.customer.findMany({
      where: { id: { in: pageIds }, organisationId },
      select: CUSTOMER_SELECT,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));

    return {
      items: pageIds
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .map((row) => ({ ...row, outstanding: outstanding.get(row.id) ?? '0.0000' })),
      page: query.page,
      limit: query.limit,
      total: ids.length,
      totalPages: Math.max(1, Math.ceil(ids.length / query.limit)),
    };
  }

  /**
   * Outstanding per customer: the sum of `amount_due` over invoices that still
   * owe money. CANCELLED and DRAFT are excluded — a draft has not been issued,
   * and a cancelled invoice is not collectable.
   */
  private async outstandingFor(
    tx: TenantClient,
    organisationId: string,
    customerIds: string[],
  ): Promise<Map<string, string>> {
    if (customerIds.length === 0) return new Map();

    const grouped = await tx.invoice.groupBy({
      by: ['customerId'],
      where: {
        organisationId,
        customerId: { in: customerIds },
        status: { in: ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] },
      },
      _sum: { amountDue: true },
    });

    return new Map(
      grouped.map((row) => [row.customerId, (row._sum.amountDue ?? new Prisma.Decimal(0)).toFixed(4)]),
    );
  }

  // -------------------------------------------------------------------------
  // Single customer
  // -------------------------------------------------------------------------

  async findOne(org: OrganisationContext, customerId: string) {
    const customer = await withTenant(org.organisationId, (tx) =>
      tx.customer.findFirst({
        where: { id: customerId, organisationId: org.organisationId },
        select: CUSTOMER_SELECT,
      }),
    );

    // Same 404 whether absent or another tenant's (Security Doc §23).
    if (!customer) {
      throw notFound(
        'CUSTOMER_NOT_FOUND',
        `Customer ${customerId} not in organisation ${org.organisationId}`,
      );
    }
    return customer;
  }

  // -------------------------------------------------------------------------
  // TICKET-010 — create
  // -------------------------------------------------------------------------

  async create(org: OrganisationContext, input: CreateCustomerInput, meta: AuditMeta) {
    return withTenant(
      org.organisationId,
      async (tx) => {
        const shipping = input.shippingSameAsBilling ? input.billing : input.shipping;

        const customer = await tx.customer.create({
          data: {
            // Tenant from verified context, never from the payload.
            organisationId: org.organisationId,
            companyId: org.companyId,
            customerType: input.customerType,
            companyName: input.companyName ?? null,
            contactName: input.contactName ?? null,
            email: input.email ?? null,
            phone: input.phone ?? null,
            taxNumber: input.taxNumber ?? null,

            billingAddressLine1: input.billing?.addressLine1 ?? null,
            billingAddressLine2: input.billing?.addressLine2 ?? null,
            billingCity: input.billing?.city ?? null,
            billingState: input.billing?.state ?? null,
            billingPostalCode: input.billing?.postalCode ?? null,
            billingCountryCode: input.billing?.countryCode ?? null,

            shippingAddressLine1: shipping?.addressLine1 ?? null,
            shippingAddressLine2: shipping?.addressLine2 ?? null,
            shippingCity: shipping?.city ?? null,
            shippingState: shipping?.state ?? null,
            shippingPostalCode: shipping?.postalCode ?? null,
            shippingCountryCode: shipping?.countryCode ?? null,

            notes: input.notes ?? null,
          },
          select: CUSTOMER_SELECT,
        });

        // Audit inside the transaction: no committed customer without its log.
        await this.audit.record(tx, {
          organisationId: org.organisationId,
          userId: meta.userId,
          action: 'CUSTOMER_CREATED',
          entityType: 'customer',
          entityId: customer.id,
          newValues: {
            customerType: customer.customerType,
            companyName: customer.companyName,
            contactName: customer.contactName,
            email: customer.email,
          },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });

        return { ...customer, outstanding: '0.0000' };
      },
      undefined,
      { userId: meta.userId },
    );
  }

  // -------------------------------------------------------------------------
  // TICKET-011 — update
  // -------------------------------------------------------------------------

  async update(
    org: OrganisationContext,
    customerId: string,
    input: UpdateCustomerInput,
    meta: AuditMeta,
  ) {
    return withTenant(
      org.organisationId,
      async (tx) => {
        const before = await tx.customer.findFirst({
          where: { id: customerId, organisationId: org.organisationId },
          select: CUSTOMER_SELECT,
        });
        if (!before) {
          throw notFound('CUSTOMER_NOT_FOUND', `Customer ${customerId} not in org`);
        }

        // Optimistic concurrency (Security Doc §24): reject a stale write
        // rather than silently overwriting a colleague's edit.
        if (input.expectedUpdatedAt) {
          const expected = new Date(input.expectedUpdatedAt).getTime();
          if (expected !== before.updatedAt.getTime()) {
            throw conflict(
              'STALE_RECORD',
              `Customer ${customerId} changed since the client loaded it`,
            );
          }
        }

        // An archived customer is read-only. Editing one would let a user
        // quietly alter the party named on historical documents.
        if (before.isArchived) {
          throw conflict(
            'INVALID_STATUS_TRANSITION',
            'Archived customers cannot be edited; restore first',
          );
        }

        const shipping = input.shippingSameAsBilling ? input.billing : input.shipping;
        const has = <K extends keyof UpdateCustomerInput>(key: K) => input[key] !== undefined;

        const customer = await tx.customer.update({
          where: { id: customerId },
          data: {
            ...(has('companyName') && { companyName: input.companyName ?? null }),
            ...(has('contactName') && { contactName: input.contactName ?? null }),
            ...(has('email') && { email: input.email ?? null }),
            ...(has('phone') && { phone: input.phone ?? null }),
            ...(has('taxNumber') && { taxNumber: input.taxNumber ?? null }),
            ...(has('notes') && { notes: input.notes ?? null }),

            ...(input.billing && {
              billingAddressLine1: input.billing.addressLine1 ?? null,
              billingAddressLine2: input.billing.addressLine2 ?? null,
              billingCity: input.billing.city ?? null,
              billingState: input.billing.state ?? null,
              billingPostalCode: input.billing.postalCode ?? null,
              billingCountryCode: input.billing.countryCode ?? null,
            }),
            ...(shipping && {
              shippingAddressLine1: shipping.addressLine1 ?? null,
              shippingAddressLine2: shipping.addressLine2 ?? null,
              shippingCity: shipping.city ?? null,
              shippingState: shipping.state ?? null,
              shippingPostalCode: shipping.postalCode ?? null,
              shippingCountryCode: shipping.countryCode ?? null,
            }),
          },
          select: CUSTOMER_SELECT,
        });

        // Log only what changed, so the trail stays readable.
        const changed: Record<string, unknown> = {};
        const previous: Record<string, unknown> = {};
        for (const key of ['companyName', 'contactName', 'email', 'phone', 'taxNumber'] as const) {
          if (before[key] !== customer[key]) {
            previous[key] = before[key];
            changed[key] = customer[key];
          }
        }

        if (Object.keys(changed).length > 0) {
          await this.audit.record(tx, {
            organisationId: org.organisationId,
            userId: meta.userId,
            action: 'CUSTOMER_UPDATED',
            entityType: 'customer',
            entityId: customerId,
            oldValues: previous,
            newValues: changed,
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
            requestId: meta.requestId,
          });
        }

        return customer;
      },
      undefined,
      { userId: meta.userId },
    );
  }

  // -------------------------------------------------------------------------
  // TICKET-011 — archive / restore
  // -------------------------------------------------------------------------

  /**
   * Archive, never delete.
   *
   * A customer with historical documents must be preserved: deleting them
   * would orphan invoices and destroy financial history (Security Doc §41
   * rule 6). The FK is `onDelete: Restrict`, so the database refuses a delete
   * regardless — archiving is the supported path, and there is no delete
   * endpoint at all.
   */
  async archive(org: OrganisationContext, customerId: string, reason: string | null, meta: AuditMeta) {
    return withTenant(
      org.organisationId,
      async (tx) => {
        const before = await tx.customer.findFirst({
          where: { id: customerId, organisationId: org.organisationId },
          select: { id: true, isArchived: true, companyName: true, contactName: true },
        });
        if (!before) throw notFound('CUSTOMER_NOT_FOUND', `Customer ${customerId} not in org`);
        if (before.isArchived) {
          throw conflict('INVALID_STATUS_TRANSITION', 'Customer is already archived');
        }

        // Warn-and-proceed rather than block: archiving a customer with open
        // invoices is legitimate (they may have gone out of business), but the
        // caller should know the balance persists.
        const openInvoices = await tx.invoice.count({
          where: {
            organisationId: org.organisationId,
            customerId,
            status: { in: ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] },
          },
        });

        const customer = await tx.customer.update({
          where: { id: customerId },
          data: { isArchived: true },
          select: CUSTOMER_SELECT,
        });

        await this.audit.record(tx, {
          organisationId: org.organisationId,
          userId: meta.userId,
          action: 'CUSTOMER_ARCHIVED',
          entityType: 'customer',
          entityId: customerId,
          oldValues: { isArchived: false },
          newValues: { isArchived: true, reason, openInvoicesAtArchive: openInvoices },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });

        return { ...customer, openInvoices };
      },
      undefined,
      { userId: meta.userId },
    );
  }

  async restore(org: OrganisationContext, customerId: string, meta: AuditMeta) {
    return withTenant(
      org.organisationId,
      async (tx) => {
        const before = await tx.customer.findFirst({
          where: { id: customerId, organisationId: org.organisationId },
          select: { id: true, isArchived: true },
        });
        if (!before) throw notFound('CUSTOMER_NOT_FOUND', `Customer ${customerId} not in org`);
        if (!before.isArchived) {
          throw conflict('INVALID_STATUS_TRANSITION', 'Customer is not archived');
        }

        const customer = await tx.customer.update({
          where: { id: customerId },
          data: { isArchived: false },
          select: CUSTOMER_SELECT,
        });

        await this.audit.record(tx, {
          organisationId: org.organisationId,
          userId: meta.userId,
          action: 'CUSTOMER_UPDATED',
          entityType: 'customer',
          entityId: customerId,
          oldValues: { isArchived: true },
          newValues: { isArchived: false },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });

        return customer;
      },
      undefined,
      { userId: meta.userId },
    );
  }

  // -------------------------------------------------------------------------
  // TICKET-013 — billing history
  // -------------------------------------------------------------------------

  /**
   * Customer detail with financial history.
   *
   * Every total is derived from stored records in one transaction, so the
   * figures are a consistent snapshot rather than several reads that could
   * disagree if a payment lands mid-request.
   */
  async billingHistory(org: OrganisationContext, customerId: string) {
    return withTenant(org.organisationId, async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: customerId, organisationId: org.organisationId },
        select: CUSTOMER_SELECT,
      });
      if (!customer) {
        throw notFound('CUSTOMER_NOT_FOUND', `Customer ${customerId} not in org`);
      }

      const scope = { organisationId: org.organisationId, customerId };

      const [quotations, invoices, payments, quotedAgg, invoicedAgg] = await Promise.all([
        tx.quotation.findMany({
          where: scope,
          select: {
            id: true,
            quotationNumber: true,
            issueDate: true,
            validUntil: true,
            status: true,
            currencyCode: true,
            totalAmount: true,
          },
          orderBy: { issueDate: 'desc' },
          take: 50,
        }),
        tx.invoice.findMany({
          where: scope,
          select: {
            id: true,
            invoiceNumber: true,
            issueDate: true,
            dueDate: true,
            status: true,
            currencyCode: true,
            totalAmount: true,
            amountPaid: true,
            amountDue: true,
          },
          orderBy: { issueDate: 'desc' },
          take: 50,
        }),
        tx.payment.findMany({
          where: { ...scope, status: 'RECORDED' },
          select: {
            id: true,
            paymentNumber: true,
            paymentDate: true,
            amount: true,
            currencyCode: true,
            paymentMethod: true,
            reference: true,
          },
          orderBy: { paymentDate: 'desc' },
          take: 50,
        }),
        // Quoted value excludes rejected/expired/cancelled — those never
        // represented real committed value.
        tx.quotation.aggregate({
          where: { ...scope, status: { in: ['SENT', 'ACCEPTED', 'CONVERTED'] } },
          _sum: { totalAmount: true },
        }),
        // Invoiced excludes DRAFT (not issued) and CANCELLED (withdrawn).
        tx.invoice.aggregate({
          where: { ...scope, status: { in: ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] } },
          _sum: { totalAmount: true, amountPaid: true, amountDue: true },
        }),
      ]);

      const zero = new Prisma.Decimal(0);

      return {
        customer,
        totals: {
          totalQuoted: (quotedAgg._sum.totalAmount ?? zero).toFixed(4),
          totalInvoiced: (invoicedAgg._sum.totalAmount ?? zero).toFixed(4),
          totalPaid: (invoicedAgg._sum.amountPaid ?? zero).toFixed(4),
          outstanding: (invoicedAgg._sum.amountDue ?? zero).toFixed(4),
        },
        quotations,
        invoices,
        payments,
      };
    });
  }
}
