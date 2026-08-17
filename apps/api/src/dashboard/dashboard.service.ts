import { Injectable } from '@nestjs/common';
import { withTenant, Prisma, type TenantClient } from '@billing/database';
import type { OrganisationContext } from '@billing/types';

/**
 * Dashboard aggregates (TICKET-039, TICKET-040).
 *
 * Every figure is derived from the same stored records the invoice and payment
 * screens use, in a single transaction, so the dashboard cannot disagree with
 * the pages a user drills into. That consistency is the point: a KPI that
 * contradicts the underlying list destroys trust in both.
 *
 * Per ADR-009's ledger principle, nothing here maintains its own running
 * total — these are read-time aggregations over authoritative rows.
 */

export interface DashboardSummary {
  currency: string;
  totals: {
    /** Issued value: excludes DRAFT (never sent) and CANCELLED (withdrawn). */
    totalInvoiced: string;
    totalPaid: string;
    outstanding: string;
    overdue: string;
  };
  counts: {
    outstandingInvoices: number;
    overdueInvoices: number;
    draftInvoices: number;
    openQuotations: number;
  };
  quotationPipeline: {
    /** Value of quotations still live: sent or accepted, not yet converted. */
    openValue: string;
    acceptedValue: string;
    sentCount: number;
    acceptedCount: number;
  };
}

export interface DashboardRecent {
  invoices: Array<{
    id: string;
    invoiceNumber: string;
    issueDate: Date;
    dueDate: Date;
    status: string;
    currencyCode: string;
    totalAmount: Prisma.Decimal;
    amountDue: Prisma.Decimal;
    customer: { id: string; companyName: string | null; contactName: string | null };
  }>;
  quotations: Array<{
    id: string;
    quotationNumber: string;
    issueDate: Date;
    validUntil: Date | null;
    status: string;
    currencyCode: string;
    totalAmount: Prisma.Decimal;
    customer: { id: string; companyName: string | null; contactName: string | null };
  }>;
  /** Invoices owing money, oldest due date first — the collections worklist. */
  outstandingInvoices: Array<{
    id: string;
    invoiceNumber: string;
    dueDate: Date;
    status: string;
    currencyCode: string;
    amountDue: Prisma.Decimal;
    customer: { id: string; companyName: string | null; contactName: string | null };
  }>;
}

/** Statuses representing money that has been billed and is collectable. */
const LIVE_INVOICE_STATUSES = ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] as const;
const COLLECTABLE_STATUSES = ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] as const;

const CUSTOMER_SELECT = { id: true, companyName: true, contactName: true } as const;

const zero = new Prisma.Decimal(0);
const money = (value: Prisma.Decimal | null | undefined) => (value ?? zero).toFixed(4);

function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

@Injectable()
export class DashboardService {
  /**
   * KPI summary.
   *
   * Run inside one transaction so every figure reflects the same instant. Read
   * separately, a payment landing mid-request could make "paid" and
   * "outstanding" disagree by that payment's amount.
   */
  async summary(org: OrganisationContext): Promise<DashboardSummary> {
    return withTenant(org.organisationId, async (tx) => {
      // Every figure on the dashboard is per company: outstanding, overdue,
      // paid and the recent lists. Two companies under one organisation keep
      // separate financial positions, which is the point of having them.
      const scope = { organisationId: org.organisationId, companyId: org.companyId };
      const today = todayUtc();

      const [organisation, issued, collectable, overdue, draftCount, sentQuotes, acceptedQuotes] =
        await Promise.all([
          tx.organisation.findUniqueOrThrow({
            where: { id: org.organisationId },
            select: { currencyCode: true },
          }),

          // Issued value and what has been paid against it.
          tx.invoice.aggregate({
            where: { ...scope, status: { in: [...LIVE_INVOICE_STATUSES] } },
            _sum: { totalAmount: true, amountPaid: true, amountDue: true },
          }),

          tx.invoice.aggregate({
            where: { ...scope, status: { in: [...COLLECTABLE_STATUSES] }, amountDue: { gt: 0 } },
            _sum: { amountDue: true },
            _count: true,
          }),

          // Overdue is computed from the due date rather than trusting the
          // status column, so the figure is right even if the scheduled
          // recalculation has not run yet.
          tx.invoice.aggregate({
            where: {
              ...scope,
              status: { in: [...COLLECTABLE_STATUSES] },
              amountDue: { gt: 0 },
              dueDate: { lt: today },
            },
            _sum: { amountDue: true },
            _count: true,
          }),

          tx.invoice.count({ where: { ...scope, status: 'DRAFT' } }),

          tx.quotation.aggregate({
            where: { ...scope, status: 'SENT' },
            _sum: { totalAmount: true },
            _count: true,
          }),

          tx.quotation.aggregate({
            where: { ...scope, status: 'ACCEPTED' },
            _sum: { totalAmount: true },
            _count: true,
          }),
        ]);

      const openValue = (sentQuotes._sum.totalAmount ?? zero).plus(
        acceptedQuotes._sum.totalAmount ?? zero,
      );

      return {
        currency: organisation.currencyCode,
        totals: {
          totalInvoiced: money(issued._sum.totalAmount),
          totalPaid: money(issued._sum.amountPaid),
          outstanding: money(collectable._sum.amountDue),
          overdue: money(overdue._sum.amountDue),
        },
        counts: {
          outstandingInvoices: collectable._count,
          overdueInvoices: overdue._count,
          draftInvoices: draftCount,
          openQuotations: sentQuotes._count + acceptedQuotes._count,
        },
        quotationPipeline: {
          openValue: money(openValue),
          acceptedValue: money(acceptedQuotes._sum.totalAmount),
          sentCount: sentQuotes._count,
          acceptedCount: acceptedQuotes._count,
        },
      };
    });
  }

  /** Recent documents and the collections worklist (TICKET-040). */
  async recent(org: OrganisationContext, limit = 5): Promise<DashboardRecent> {
    return withTenant(org.organisationId, async (tx) => {
      // Every figure on the dashboard is per company: outstanding, overdue,
      // paid and the recent lists. Two companies under one organisation keep
      // separate financial positions, which is the point of having them.
      const scope = { organisationId: org.organisationId, companyId: org.companyId };

      const [invoices, quotations, outstandingInvoices] = await Promise.all([
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
            amountDue: true,
            customer: { select: CUSTOMER_SELECT },
          },
          // createdAt, not issueDate: "recent" means recently entered, and a
          // back-dated invoice entered today should still appear at the top.
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),

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
            customer: { select: CUSTOMER_SELECT },
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),

        tx.invoice.findMany({
          where: {
            ...scope,
            status: { in: [...COLLECTABLE_STATUSES] },
            amountDue: { gt: 0 },
          },
          select: {
            id: true,
            invoiceNumber: true,
            dueDate: true,
            status: true,
            currencyCode: true,
            amountDue: true,
            customer: { select: CUSTOMER_SELECT },
          },
          // Oldest due date first: the most overdue needs attention soonest.
          orderBy: { dueDate: 'asc' },
          take: limit,
        }),
      ]);

      return { invoices, quotations, outstandingInvoices };
    });
  }
}
