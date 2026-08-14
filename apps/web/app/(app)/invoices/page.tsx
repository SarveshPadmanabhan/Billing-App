'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Search, Plus, AlertTriangle } from 'lucide-react';
import type { CurrentUserResponse, InvoiceStatus } from '@billing/types';
import { hasPermission } from '@billing/types';
import { apiFetch, ApiRequestError } from '../../../lib/api-client';
import { listInvoices, INVOICE_STATUS_TONE, type InvoiceListParams } from '../../../lib/invoices';
import { customerName } from '../../../lib/customers';
import {
  Button,
  Card,
  Badge,
  Money,
  Input,
  Select,
  EmptyState,
  ErrorState,
  PermissionDenied,
  TableSkeleton,
} from '../../../components/ui/primitives';

/** TICKET-023 — invoice list. */

const STATUSES: InvoiceStatus[] = [
  'DRAFT',
  'SENT',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'CANCELLED',
];

const humanStatus = (s: string) =>
  s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

/** True when the due date has passed and money is still owed. */
function isPastDue(dueDate: string, amountDue: string, status: InvoiceStatus): boolean {
  if (status === 'PAID' || status === 'CANCELLED' || status === 'DRAFT') return false;
  return Number(amountDue) > 0 && new Date(dueDate) < new Date();
}

export default function InvoicesPage() {
  const searchParams = useSearchParams();
  const urlStatus = searchParams?.get('status');
  const urlSearch = searchParams?.get('search') ?? '';
  const urlOutstanding = searchParams?.get('outstanding') === 'true';

  const [search, setSearch] = useState(urlSearch);
  const [debounced, setDebounced] = useState(urlSearch);
  const [status, setStatus] = useState<InvoiceStatus | ''>(
    urlStatus && (STATUSES as string[]).includes(urlStatus) ? (urlStatus as InvoiceStatus) : '',
  );
  const [outstandingOnly, setOutstandingOnly] = useState(urlOutstanding);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const { data: me } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<CurrentUserResponse>('/auth/me'),
  });

  const params: InvoiceListParams = {
    page,
    limit: 25,
    ...(debounced && { search: debounced }),
    // The outstanding filter selects its own statuses, so the two are
    // mutually exclusive rather than combined into an impossible query.
    ...(outstandingOnly ? { outstanding: 'true' as const } : status ? { status } : {}),
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

  const isFiltered = Boolean(debounced || status || outstandingOnly);

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

      <Card className="flex flex-wrap items-end gap-4 p-4">
        <div className="flex min-w-[240px] flex-1 flex-col gap-2">
          <label htmlFor="invoice-search" className="text-body-sm font-medium text-ink">
            Search
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
              aria-hidden="true"
            />
            <Input
              id="invoice-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Number or customer"
              className="pl-9"
            />
          </div>
        </div>

        <div className="flex w-[200px] flex-col gap-2">
          <label htmlFor="invoice-status" className="text-body-sm font-medium text-ink">
            Status
          </label>
          <Select
            id="invoice-status"
            value={status}
            disabled={outstandingOnly}
            onChange={(e) => {
              setStatus(e.target.value as InvoiceStatus | '');
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanStatus(s)}
              </option>
            ))}
          </Select>
        </div>

        <label className="flex h-10 items-center gap-2 text-body-sm text-ink-secondary">
          <input
            type="checkbox"
            checked={outstandingOnly}
            onChange={(e) => {
              setOutstandingOnly(e.target.checked);
              setPage(1);
            }}
            className="h-4 w-4 rounded border-border-strong text-primary focus:ring-2 focus:ring-primary-light"
          />
          Outstanding only
        </label>
      </Card>

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
          title={isFiltered ? 'No matching invoices' : 'No invoices yet'}
          description={
            isFiltered
              ? 'Try a different search or clear the filters.'
              : 'Create an invoice directly, or convert an accepted quotation.'
          }
          action={
            isFiltered ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch('');
                  setStatus('');
                  setOutstandingOnly(false);
                }}
              >
                Clear filters
              </Button>
            ) : canWrite ? (
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
              <table className="w-full min-w-[920px] border-collapse">
                <caption className="sr-only">Invoices</caption>
                <thead>
                  <tr className="border-b border-border bg-canvas">
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Number
                    </th>
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Customer
                    </th>
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Issued
                    </th>
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
                        <td className="p-4 text-body text-ink-secondary">
                          {formatDate(invoice.issueDate)}
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
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  disabled={data.page >= data.totalPages}
                  onClick={() => setPage((p) => p + 1)}
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
