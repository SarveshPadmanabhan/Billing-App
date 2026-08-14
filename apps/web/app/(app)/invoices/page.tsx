'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Plus, AlertTriangle } from 'lucide-react';
import type { CurrentUserResponse, InvoiceStatus } from '@billing/types';
import { hasPermission } from '@billing/types';
import { apiFetch, ApiRequestError } from '../../../lib/api-client';
import { listInvoices, INVOICE_STATUS_TONE, type InvoiceListParams } from '../../../lib/invoices';
import { customerName } from '../../../lib/customers';
import { useUrlFilters } from '../../../lib/use-url-filters';
import { DocumentFilters, hasActiveFilters } from '../../../components/documents/document-filters';
import {
  Button,
  Card,
  Badge,
  Money,
  EmptyState,
  ErrorState,
  PermissionDenied,
  TableSkeleton,
} from '../../../components/ui/primitives';

/** TICKET-023 — invoice list, with TICKET-037 combined filters. */

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SENT', label: 'Sent' },
  { value: 'PARTIALLY_PAID', label: 'Partially paid' },
  { value: 'PAID', label: 'Paid' },
  { value: 'OVERDUE', label: 'Overdue' },
  { value: 'CANCELLED', label: 'Cancelled' },
] as const;

const humanStatus = (s: string) =>
  s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

function isPastDue(dueDate: string, amountDue: string, status: InvoiceStatus): boolean {
  if (status === 'PAID' || status === 'CANCELLED' || status === 'DRAFT') return false;
  return Number(amountDue) > 0 && new Date(dueDate) < new Date();
}

export default function InvoicesPage() {
  const { filters, applied, setFilters, page, setPage } = useUrlFilters(['outstanding']);

  const { data: me } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<CurrentUserResponse>('/auth/me'),
  });

  const outstandingOnly = applied.outstanding === 'true';

  const params: InvoiceListParams = {
    page,
    limit: 25,
    ...(applied.search && { search: applied.search }),
    ...(applied.customerId && { customerId: applied.customerId }),
    ...(applied.dateFrom && { dateFrom: applied.dateFrom }),
    ...(applied.dateTo && { dateTo: applied.dateTo }),
    // The outstanding filter picks its own set of statuses, so combining it
    // with an explicit status would build a contradictory query.
    ...(outstandingOnly
      ? { outstanding: 'true' as const }
      : applied.status
        ? { status: applied.status as InvoiceStatus }
        : {}),
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['invoices', params],
    queryFn: () => listInvoices(params),
    placeholderData: (previous) => previous,
  });

  const role = me?.organisation?.role;
  const canView = role ? hasPermission(role, 'invoice:view') : true;
  const canWrite = role ? hasPermission(role, 'invoice:write') : false;

  if (role && !canView) return <PermissionDenied />;

  const filtered = hasActiveFilters(filters);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-h1 text-ink">Invoices</h1>
          <p className="mt-1 text-body text-ink-muted">
            {data ? `${data.total} ${data.total === 1 ? 'invoice' : 'invoices'}` : ' '}
          </p>
        </div>
        {canWrite && (
          <Link href="/invoices/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden="true" />
              New invoice
            </Button>
          </Link>
        )}
      </header>

      <DocumentFilters
        values={filters}
        onChange={setFilters}
        statuses={STATUSES}
        searchPlaceholder="Number or customer"
        extra={
          <label className="flex h-10 items-center gap-2 text-body-sm text-ink-secondary">
            <input
              type="checkbox"
              checked={outstandingOnly}
              onChange={(e) =>
                setFilters({
                  ...filters,
                  outstanding: e.target.checked ? 'true' : '',
                  // Clear a conflicting status when switching to outstanding.
                  status: e.target.checked ? '' : filters.status,
                })
              }
              className="h-4 w-4 rounded border-border-strong text-primary focus:ring-2 focus:ring-primary-light"
            />
            Outstanding only
          </label>
        }
      />

      {isLoading ? (
        <TableSkeleton rows={6} columns={7} />
      ) : error ? (
        <ErrorState
          message={
            error instanceof ApiRequestError ? error.message : 'We could not load your invoices.'
          }
          onRetry={() => refetch()}
        />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          title={filtered ? 'No matching invoices' : 'No invoices yet'}
          description={
            filtered
              ? 'No invoices match these filters. Try widening the date range or clearing them.'
              : 'Create an invoice directly, or convert an accepted quotation.'
          }
          action={
            !filtered && canWrite ? (
              <Link href="/invoices/new">
                <Button>New invoice</Button>
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-md border border-border bg-surface shadow-card">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse">
                <caption className="sr-only">Invoices</caption>
                <thead>
                  <tr className="border-b border-border bg-canvas">
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Number
                    </th>
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Customer
                    </th>
                    {/* "Issued" is dropped: it duplicates information the
                        number already conveys, and at 1024px the sidebar
                        leaves only ~728px, so seven columns forced horizontal
                        scrolling on an ordinary laptop. Due date is the one
                        that drives action. */}
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Due
                    </th>
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Status
                    </th>
                    <th scope="col" className="p-4 text-right text-body-sm font-semibold text-ink-secondary">
                      Total
                    </th>
                    <th scope="col" className="p-4 text-right text-body-sm font-semibold text-ink-secondary">
                      Balance
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((invoice) => {
                    const overdue = isPastDue(invoice.dueDate, invoice.amountDue, invoice.status);
                    return (
                      <tr key={invoice.id} className="border-b border-border last:border-b-0 hover:bg-canvas">
                        <td className="p-4">
                          <Link
                            href={`/invoices/${invoice.id}`}
                            className="text-body font-medium text-primary hover:underline"
                          >
                            {invoice.invoiceNumber}
                          </Link>
                        </td>
                        <td className="p-4 text-body text-ink">
                          {invoice.customer ? customerName(invoice.customer) : '—'}
                        </td>
                        <td className="p-4 text-body">
                          <span className={overdue ? 'font-medium text-danger' : 'text-ink-secondary'}>
                            {formatDate(invoice.dueDate)}
                          </span>
                          {overdue && (
                            <AlertTriangle
                              className="ml-1 inline h-3.5 w-3.5 text-danger"
                              aria-label="Past due"
                            />
                          )}
                        </td>
                        <td className="p-4">
                          <Badge tone={INVOICE_STATUS_TONE[invoice.status]}>
                            {humanStatus(invoice.status)}
                          </Badge>
                        </td>
                        <td className="p-4 text-right text-body text-ink-secondary">
                          <Money amount={invoice.totalAmount} currency={invoice.currencyCode} />
                        </td>
                        <td className="p-4 text-right text-body">
                          <span
                            className={
                              Number(invoice.amountDue) > 0 ? 'font-medium text-ink' : 'text-ink-muted'
                            }
                          >
                            <Money amount={invoice.amountDue} currency={invoice.currencyCode} />
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {data.totalPages > 1 && (
            <nav className="flex items-center justify-between" aria-label="Pagination">
              <p className="text-body-sm text-ink-muted" aria-live="polite">
                Page {data.page} of {data.totalPages}
                {isFetching && ' · updating…'}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  disabled={data.page <= 1}
                  onClick={() => setPage(Math.max(1, page - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={data.page >= data.totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
