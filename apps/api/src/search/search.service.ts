import { Injectable } from '@nestjs/common';
import { withTenant, Prisma } from '@billing/database';
import { hasPermission, type OrganisationContext } from '@billing/types';

/**
 * Global document search (TICKET-036).
 *
 * Distinct from the per-list search already on each module: this answers
 * "where is INV-000042?" or "show me everything for Northwind" from one input,
 * without the user first choosing which module to look in.
 *
 * Two properties matter:
 *   - Organisation-scoped. Every query runs inside withTenant, so RLS applies
 *     on top of the explicit organisationId filter.
 *   - Permission-aware. A role that cannot view invoices gets no invoice
 *     results, rather than a filtered-looking list that leaks their existence
 *     through result counts.
 */

export interface SearchResult {
  type: 'customer' | 'quotation' | 'invoice';
  id: string;
  /** Primary label: document number, or customer name. */
  title: string;
  /** Supporting line: customer name, or contact details. */
  subtitle: string | null;
  status: string | null;
  amount: string | null;
  currencyCode: string | null;
  date: string | null;
  url: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  counts: { customers: number; quotations: number; invoices: number };
  /** True when any group was truncated to the per-type limit. */
  truncated: boolean;
}

/** Per-type cap. Keeps the response small and the query fast. */
const PER_TYPE_LIMIT = 5;

@Injectable()
export class SearchService {
  async search(
    org: OrganisationContext,
    rawQuery: string,
    limit = PER_TYPE_LIMIT,
  ): Promise<SearchResponse> {
    const query = rawQuery.trim();

    // An empty search returns nothing rather than everything: this powers a
    // type-ahead, and returning the full dataset on an empty box would be both
    // slow and useless (TICKET-036: "empty search restores the normal list").
    if (query.length === 0) {
      return {
        query,
        results: [],
        counts: { customers: 0, quotations: 0, invoices: 0 },
        truncated: false,
      };
    }

    const canSeeCustomers = hasPermission(org.role, 'customer:view');
    const canSeeQuotations = hasPermission(org.role, 'quotation:view');
    const canSeeInvoices = hasPermission(org.role, 'invoice:view');

    return withTenant(org.organisationId, async (tx) => {
      const contains = { contains: query, mode: 'insensitive' as const };
      const scope = { organisationId: org.organisationId };

      const [customers, customerCount, quotations, quotationCount, invoices, invoiceCount] =
        await Promise.all([
          canSeeCustomers
            ? tx.customer.findMany({
                where: {
                  ...scope,
                  OR: [
                    { companyName: contains },
                    { contactName: contains },
                    { email: contains },
                    { phone: contains },
                  ],
                },
                select: {
                  id: true,
                  companyName: true,
                  contactName: true,
                  email: true,
                  isArchived: true,
                },
                // Active customers first, then most recent.
                orderBy: [{ isArchived: 'asc' }, { createdAt: 'desc' }],
                take: limit,
              })
            : [],
          canSeeCustomers
            ? tx.customer.count({
                where: {
                  ...scope,
                  OR: [
                    { companyName: contains },
                    { contactName: contains },
                    { email: contains },
                    { phone: contains },
                  ],
                },
              })
            : 0,

          canSeeQuotations
            ? tx.quotation.findMany({
                where: {
                  ...scope,
                  OR: [
                    { quotationNumber: contains },
                    { customer: { companyName: contains } },
                    { customer: { contactName: contains } },
                  ],
                },
                select: {
                  id: true,
                  quotationNumber: true,
                  status: true,
                  totalAmount: true,
                  currencyCode: true,
                  issueDate: true,
                  customer: { select: { companyName: true, contactName: true } },
                },
                orderBy: { issueDate: 'desc' },
                take: limit,
              })
            : [],
          canSeeQuotations
            ? tx.quotation.count({
                where: {
                  ...scope,
                  OR: [
                    { quotationNumber: contains },
                    { customer: { companyName: contains } },
                    { customer: { contactName: contains } },
                  ],
                },
              })
            : 0,

          canSeeInvoices
            ? tx.invoice.findMany({
                where: {
                  ...scope,
                  OR: [
                    { invoiceNumber: contains },
                    { customer: { companyName: contains } },
                    { customer: { contactName: contains } },
                  ],
                },
                select: {
                  id: true,
                  invoiceNumber: true,
                  status: true,
                  totalAmount: true,
                  amountDue: true,
                  currencyCode: true,
                  issueDate: true,
                  customer: { select: { companyName: true, contactName: true } },
                },
                orderBy: { issueDate: 'desc' },
                take: limit,
              })
            : [],
          canSeeInvoices
            ? tx.invoice.count({
                where: {
                  ...scope,
                  OR: [
                    { invoiceNumber: contains },
                    { customer: { companyName: contains } },
                    { customer: { contactName: contains } },
                  ],
                },
              })
            : 0,
        ]);

      const name = (c: { companyName: string | null; contactName: string | null } | null) =>
        c?.companyName || c?.contactName || 'Customer';

      const results: SearchResult[] = [
        // Invoices first: "where is INV-000042" is the most common reason to
        // reach for a global search.
        ...invoices.map((invoice) => ({
          type: 'invoice' as const,
          id: invoice.id,
          title: invoice.invoiceNumber,
          subtitle: name(invoice.customer),
          status: invoice.status,
          amount: invoice.totalAmount.toFixed(4),
          currencyCode: invoice.currencyCode,
          date: invoice.issueDate.toISOString(),
          url: `/invoices/${invoice.id}`,
        })),
        ...quotations.map((quotation) => ({
          type: 'quotation' as const,
          id: quotation.id,
          title: quotation.quotationNumber,
          subtitle: name(quotation.customer),
          status: quotation.status,
          amount: quotation.totalAmount.toFixed(4),
          currencyCode: quotation.currencyCode,
          date: quotation.issueDate.toISOString(),
          url: `/quotations/${quotation.id}`,
        })),
        ...customers.map((customer) => ({
          type: 'customer' as const,
          id: customer.id,
          title: customer.companyName || customer.contactName || 'Customer',
          subtitle: customer.email,
          status: customer.isArchived ? 'ARCHIVED' : null,
          amount: null,
          currencyCode: null,
          date: null,
          url: `/customers/${customer.id}`,
        })),
      ];

      return {
        query,
        results,
        counts: {
          customers: customerCount,
          quotations: quotationCount,
          invoices: invoiceCount,
        },
        truncated:
          customerCount > customers.length ||
          quotationCount > quotations.length ||
          invoiceCount > invoices.length,
      };
    });
  }
}
