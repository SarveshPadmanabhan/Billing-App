'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { CurrentUserResponse, QuotationStatus } from '@billing/types';
import { hasPermission } from '@billing/types';
import { apiFetch, ApiRequestError } from '../../../lib/api-client';
import {
  listQuotations,
  QUOTATION_STATUS_TONE,
  type QuotationListParams,
} from '../../../lib/quotations';
import { customerName } from '../../../lib/customers';
import { useUrlFilters } from '../../../lib/use-url-filters';
import { DocumentFilters, hasActiveFilters } from '../../../components/documents/document-filters';
import {
  Button,
  Badge,
  Money,
  EmptyState,
  ErrorState,
  PermissionDenied,
  TableSkeleton,
} from '../../../components/ui/primitives';

/** TICKET-014 — quotation list, with TICKET-037 combined filters. */

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SENT', label: 'Sent' },
  { value: 'ACCEPTED', label: 'Accepted' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'CONVERTED', label: 'Converted' },
  { value: 'CANCELLED', label: 'Cancelled' },
] as const;

const humanStatus = (s: string) =>
  s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export default function QuotationsPage() {
  const { filters, applied, setFilters, page, setPage } = useUrlFilters();

  const { data: me } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<CurrentUserResponse>('/auth/me'),
  });

  const params: QuotationListParams = {
    page,
    limit: 25,
    ...(applied.search && { search: applied.search }),
    ...(applied.status && { status: applied.status as QuotationStatus }),
    ...(applied.customerId && { customerId: applied.customerId }),
    ...(applied.dateFrom && { dateFrom: applied.dateFrom }),
    ...(applied.dateTo && { dateTo: applied.dateTo }),
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

  const filtered = hasActiveFilters(filters);

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

      <DocumentFilters
        values={filters}
        onChange={setFilters}
        statuses={STATUSES}
        searchPlaceholder="Number or customer"
      />

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
          title={filtered ? 'No matching quotations' : 'No quotations yet'}
          description={
            filtered
              ? 'No quotations match these filters. Try widening the date range or clearing them.'
              : 'Create a quotation to send a priced offer to a customer.'
          }
          action={
            !filtered && canWrite ? (
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
