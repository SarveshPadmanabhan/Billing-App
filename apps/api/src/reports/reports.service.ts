import { Injectable } from '@nestjs/common';
import { Prisma, withTenant } from '@billing/database';
import type { OrganisationContext } from '@billing/types';
import {
  LIVE_INVOICE_STATUSES,
  COLLECTABLE_STATUSES,
  todayUtc,
} from '../common/finance/invoice-status.js';

/**
 * Reporting.
 *
 * Every figure is derived from the invoice and payment rows at query time, not
 * from a stored aggregate. A report that disagrees with the ledger is worse
 * than no report, so nothing here caches or increments.
 *
 * Both reports are company-scoped, like the dashboard and every list view: two
 * companies under one organisation keep separate financial positions.
 *
 * Money crosses the API as decimal strings, never JSON numbers.
 */
@Injectable()
export class ReportsService {
  /**
   * Aging: outstanding balances bucketed by how long they have been overdue.
   *
   * Buckets are by days past the DUE date, which is the standard accounting
   * reading — "current" means billed but not yet due, not "recently issued".
   */
  async aging(org: OrganisationContext): Promise<AgingReport> {
    return withTenant(org.organisationId, async (tx) => {
      const today = todayUtc();

      const invoices = await tx.invoice.findMany({
        where: {
          organisationId: org.organisationId,
          companyId: org.companyId,
          status: { in: [...COLLECTABLE_STATUSES] },
          amountDue: { gt: 0 },
        },
        select: {
          id: true,
          invoiceNumber: true,
          dueDate: true,
          amountDue: true,
          currencyCode: true,
          customer: { select: { id: true, companyName: true, contactName: true } },
        },
        orderBy: { dueDate: 'asc' },
      });

      const byCustomer = new Map<string, AgingRow>();

      for (const invoice of invoices) {
        const key = invoice.customer.id;
        const row =
          byCustomer.get(key) ??
          {
            customerId: key,
            customerName:
              invoice.customer.companyName || invoice.customer.contactName || 'Unnamed customer',
            current: new Prisma.Decimal(0),
            days1To30: new Prisma.Decimal(0),
            days31To60: new Prisma.Decimal(0),
            days61To90: new Prisma.Decimal(0),
            days90Plus: new Prisma.Decimal(0),
            total: new Prisma.Decimal(0),
            oldestDueDate: invoice.dueDate,
            invoiceCount: 0,
          };

        // Whole days between the due date and today. Both are UTC midnight, so
        // this is exact — no timezone drift pushing an invoice into the wrong
        // bucket at the boundary.
        const daysOverdue = Math.floor(
          (today.getTime() - invoice.dueDate.getTime()) / 86_400_000,
        );

        if (daysOverdue <= 0) row.current = row.current.plus(invoice.amountDue);
        else if (daysOverdue <= 30) row.days1To30 = row.days1To30.plus(invoice.amountDue);
        else if (daysOverdue <= 60) row.days31To60 = row.days31To60.plus(invoice.amountDue);
        else if (daysOverdue <= 90) row.days61To90 = row.days61To90.plus(invoice.amountDue);
        else row.days90Plus = row.days90Plus.plus(invoice.amountDue);

        row.total = row.total.plus(invoice.amountDue);
        row.invoiceCount += 1;
        if (invoice.dueDate < row.oldestDueDate) row.oldestDueDate = invoice.dueDate;

        byCustomer.set(key, row);
      }

      const rows = [...byCustomer.values()].sort((a, b) => b.total.comparedTo(a.total));

      const totals = rows.reduce(
        (acc, row) => ({
          current: acc.current.plus(row.current),
          days1To30: acc.days1To30.plus(row.days1To30),
          days31To60: acc.days31To60.plus(row.days31To60),
          days61To90: acc.days61To90.plus(row.days61To90),
          days90Plus: acc.days90Plus.plus(row.days90Plus),
          total: acc.total.plus(row.total),
        }),
        {
          current: new Prisma.Decimal(0),
          days1To30: new Prisma.Decimal(0),
          days31To60: new Prisma.Decimal(0),
          days61To90: new Prisma.Decimal(0),
          days90Plus: new Prisma.Decimal(0),
          total: new Prisma.Decimal(0),
        },
      );

      const currencyCode = invoices[0]?.currencyCode ?? 'INR';

      return {
        asOf: today.toISOString().slice(0, 10),
        currencyCode,
        rows: rows.map((row) => ({
          customerId: row.customerId,
          customerName: row.customerName,
          invoiceCount: row.invoiceCount,
          oldestDueDate: row.oldestDueDate.toISOString().slice(0, 10),
          current: row.current.toFixed(4),
          days1To30: row.days1To30.toFixed(4),
          days31To60: row.days31To60.toFixed(4),
          days61To90: row.days61To90.toFixed(4),
          days90Plus: row.days90Plus.toFixed(4),
          total: row.total.toFixed(4),
        })),
        totals: {
          current: totals.current.toFixed(4),
          days1To30: totals.days1To30.toFixed(4),
          days31To60: totals.days31To60.toFixed(4),
          days61To90: totals.days61To90.toFixed(4),
          days90Plus: totals.days90Plus.toFixed(4),
          total: totals.total.toFixed(4),
        },
      };
    });
  }

  /**
   * Revenue by month: what was invoiced, and what was actually collected.
   *
   * These are deliberately two different things and are NOT expected to match
   * within a month. An invoice issued in March and paid in May contributes to
   * March's invoiced figure and May's collected figure. Reporting only one
   * would answer a different question than most people are asking.
   *
   * Collected is summed from payment allocations rather than invoice
   * amountPaid, so the month is the month the money arrived.
   */
  async revenue(org: OrganisationContext, range: RevenueRange): Promise<RevenueReport> {
    return withTenant(org.organisationId, async (tx) => {
      const today = todayUtc();

      // An explicit range wins over the month count. Both are snapped to whole
      // months because the report groups by month: a range starting mid-month
      // would silently drop the earlier part of that month's figures while
      // still labelling the row with the whole month.
      const start = range.from
        ? startOfMonth(range.from)
        : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (range.months - 1), 1));

      const endMonth = range.to ? startOfMonth(range.to) : startOfMonth(today);

      // `end` is the first instant AFTER the last month, so the SQL can use a
      // half-open range. Comparing with <= against a month start would exclude
      // everything after midnight on the 1st.
      const end = new Date(Date.UTC(endMonth.getUTCFullYear(), endMonth.getUTCMonth() + 1, 1));

      const monthCount = Math.max(
        1,
        (endMonth.getUTCFullYear() - start.getUTCFullYear()) * 12 +
          (endMonth.getUTCMonth() - start.getUTCMonth()) +
          1,
      );

      const [invoiced, collected, organisation] = await Promise.all([
        tx.$queryRaw<Array<{ month: string; amount: Prisma.Decimal; count: bigint }>>`
          SELECT to_char(date_trunc('month', issue_date), 'YYYY-MM') AS month,
                 COALESCE(SUM(total_amount), 0) AS amount,
                 count(*) AS count
            FROM invoices
           WHERE organisation_id = ${org.organisationId}::uuid
             AND company_id = ${org.companyId}::uuid
             AND status = ANY(${[...LIVE_INVOICE_STATUSES]}::invoice_status[])
             AND issue_date >= ${start}
             AND issue_date < ${end}
           GROUP BY 1 ORDER BY 1
        `,
        // Allocations, not invoice.amountPaid: this asks when cash arrived.
        // Voided payments are excluded — reversed money was never collected.
        tx.$queryRaw<Array<{ month: string; amount: Prisma.Decimal }>>`
          SELECT to_char(date_trunc('month', p.payment_date), 'YYYY-MM') AS month,
                 COALESCE(SUM(pa.allocated_amount), 0) AS amount
            FROM payment_allocations pa
            JOIN payments p ON p.id = pa.payment_id
           WHERE p.organisation_id = ${org.organisationId}::uuid
             AND p.company_id = ${org.companyId}::uuid
             AND p.status = 'RECORDED'
             AND p.payment_date >= ${start}
             AND p.payment_date < ${end}
           GROUP BY 1 ORDER BY 1
        `,
        tx.organisation.findUniqueOrThrow({
          where: { id: org.organisationId },
          select: { currencyCode: true },
        }),
      ]);

      const invoicedBy = new Map(invoiced.map((r) => [r.month, r]));
      const collectedBy = new Map(collected.map((r) => [r.month, r.amount]));

      // Emit every month in the range, including empty ones. A chart that
      // silently skips a month with no activity misrepresents the trend.
      const rows: RevenueRow[] = [];
      for (let i = 0; i < monthCount; i += 1) {
        const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        rows.push({
          month: key,
          invoiced: (invoicedBy.get(key)?.amount ?? new Prisma.Decimal(0)).toFixed(4),
          collected: (collectedBy.get(key) ?? new Prisma.Decimal(0)).toFixed(4),
          invoiceCount: Number(invoicedBy.get(key)?.count ?? 0n),
        });
      }

      const sum = (pick: (r: RevenueRow) => string) =>
        rows
          .reduce((acc, r) => acc.plus(new Prisma.Decimal(pick(r))), new Prisma.Decimal(0))
          .toFixed(4);

      return {
        currencyCode: organisation.currencyCode,
        from: rows[0]?.month ?? '',
        to: rows[rows.length - 1]?.month ?? '',
        months: rows,
        totals: {
          invoiced: sum((r) => r.invoiced),
          collected: sum((r) => r.collected),
          invoiceCount: rows.reduce((acc, r) => acc + r.invoiceCount, 0),
        },
      };
    });
  }
}

interface AgingRow {
  customerId: string;
  customerName: string;
  current: Prisma.Decimal;
  days1To30: Prisma.Decimal;
  days31To60: Prisma.Decimal;
  days61To90: Prisma.Decimal;
  days90Plus: Prisma.Decimal;
  total: Prisma.Decimal;
  oldestDueDate: Date;
  invoiceCount: number;
}

export interface AgingReport {
  asOf: string;
  currencyCode: string;
  rows: Array<{
    customerId: string;
    customerName: string;
    invoiceCount: number;
    oldestDueDate: string;
    current: string;
    days1To30: string;
    days31To60: string;
    days61To90: string;
    days90Plus: string;
    total: string;
  }>;
  totals: {
    current: string;
    days1To30: string;
    days31To60: string;
    days61To90: string;
    days90Plus: string;
    total: string;
  };
}

/** Whole-month boundary, so grouping and filtering agree. */
function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export interface RevenueRange {
  /** Used when `from`/`to` are absent. */
  months: number;
  from?: Date;
  to?: Date;
}

interface RevenueRow {
  month: string;
  invoiced: string;
  collected: string;
  invoiceCount: number;
}

export interface RevenueReport {
  currencyCode: string;
  /** First and last month actually covered, as YYYY-MM. */
  from: string;
  to: string;
  months: RevenueRow[];
  totals: { invoiced: string; collected: string; invoiceCount: number };
}
