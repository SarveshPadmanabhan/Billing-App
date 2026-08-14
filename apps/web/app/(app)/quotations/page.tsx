'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Search, Plus } from 'lucide-react';
import type { CurrentUserResponse, QuotationStatus } from '@billing/types';
import { hasPermission } from '@billing/types';
import { apiFetch, ApiRequestError } from '../../../lib/api-client';
import {
  listQuotations,
  QUOTATION_STATUS_TONE,
  type QuotationListParams,
} from '../../../lib/quotations';
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

/** TICKET-014 — quotation list. */

const STATUSES: QuotationStatus[] = [
  'DRAFT',
  'SENT',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'CONVERTED',
  'CANCELLED',
];

const humanStatus = (s: string) =>
  s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export default function QuotationsPage() {
  // Seed filters from the URL so a shared or bookmarked link such as
  // /quotations?status=DRAFT opens with that filter applied.
  const searchParams = useSearchParams();
  const initialStatus = searchParams?.get('status');
  const initialSearch = searchParams?.get('search') ?? '';

  const [search, setSearch] = useState(initialSearch);
  const [debounced, setDebounced] = useState(initialSearch);
  const [status, setStatus] = useState<QuotationStatus | ''>(
    initialStatus && (STATUSES as string[]).includes(initialStatus)
      ? (initialStatus as QuotationStatus)
      : '',
  );
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

  const params: QuotationListParams = {
    page,
    limit: 25,
    ...(debounced && { search: debounced }),
    ...(status && { status }),
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['quotations', params],
    queryFn: () => listQuotations(params),
    placeholderData: (previous) => previous,
  });

  const role = me?.organisation?.role;
  const canView = role ? hasPermission(role, 'quotation:view') : true;
  const canWrite = role ? hasPermission(role, 'quotation:write') : false;

  if (role && !canView) return <PermissionDenied />;

  const isFiltered = Boolean(debounced || status);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-h1 text-ink">Quotations</h1>
          <p className="mt-1 text-body text-ink-muted">
            {data ? `${data.total} ${data.total === 1 ? 'quotation' : 'quotations'}` : ' '}
          </p>
        </div>
        {canWrite && (
          <Link href="/quotations/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden="true" />
              New quotation
            </Button>
          </Link>
        )}
      </header>

      <Card className="flex flex-wrap items-end gap-4 p-4">
        <div className="flex min-w-[240px] flex-1 flex-col gap-2">
          <label htmlFor="quotation-search" className="text-body-sm font-medium text-ink">
            Search
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
              aria-hidden="true"
            />
            <Input
              id="quotation-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Number or customer"
              className="pl-9"
            />
          </div>
        </div>

        <div className="flex w-[200px] flex-col gap-2">
          <label htmlFor="quotation-status" className="text-body-sm font-medium text-ink">
            Status
          </label>
          <Select
            id="quotation-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as QuotationStatus | '');
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
      </Card>

      {isLoading ? (
        <TableSkeleton rows={6} columns={6} />
      ) : error ? (
        <ErrorState
          message={
            error instanceof ApiRequestError ? error.message : 'We could not load your quotations.'
          }
          onRetry={() => refetch()}
        />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          title={isFiltered ? 'No matching quotations' : 'No quotations yet'}
          description={
            isFiltered
              ? 'Try a different search or clear the filters.'
              : 'Create a quotation to send a priced offer to a customer.'
          }
          action={
            isFiltered ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch('');
                  setStatus('');
                }}
              >
                Clear filters
              </Button>
            ) : canWrite ? (
              <Link href="/quotations/new">
                <Button>New quotation</Button>
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-md border border-border bg-surface shadow-card">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] border-collapse">
                <caption className="sr-only">Quotations</caption>
                <thead>
                  <tr className="border-b border-border bg-canvas">
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Number
                    </th>
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Customer
                    </th>
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Date
                    </th>
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Valid until
                    </th>
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Status
                    </th>
                    <th scope="col" className="p-4 text-right text-body-sm font-semibold text-ink-secondary">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((quotation) => (
                    <tr key={quotation.id} className="border-b border-border last:border-b-0 hover:bg-canvas">
                      <td className="p-4">
                        <Link
                          href={`/quotations/${quotation.id}`}
                          className="text-body font-medium text-primary hover:underline"
                        >
                          {quotation.quotationNumber}
                        </Link>
                      </td>
                      <td className="p-4 text-body text-ink">
                        {quotation.customer ? customerName(quotation.customer) : '—'}
                      </td>
                      <td className="p-4 text-body text-ink-secondary">
                        {formatDate(quotation.issueDate)}
                      </td>
                      <td className="p-4 text-body text-ink-secondary">
                        {quotation.validUntil ? formatDate(quotation.validUntil) : '—'}
                      </td>
                      <td className="p-4">
                        <Badge tone={QUOTATION_STATUS_TONE[quotation.status]}>
                          {humanStatus(quotation.status)}
                        </Badge>
                      </td>
                      <td className="p-4 text-right text-body text-ink">
                        <Money amount={quotation.totalAmount} currency={quotation.currencyCode} />
                      </td>
                    </tr>
                  ))}
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
