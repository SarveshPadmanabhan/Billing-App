'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { CurrentUserResponse } from '@billing/types';
import { hasPermission } from '@billing/types';
import { apiFetch, ApiRequestError } from '../../../lib/api-client';
import {
  listPayments,
  paymentMethodLabel,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type PaymentListParams,
  type PaymentMethod,
} from '../../../lib/payments';
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

/** TICKET-033 — payment history. */

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export default function PaymentsPage() {
  const searchParams = useSearchParams();
  const urlStatus = searchParams?.get('status');
  const urlSearch = searchParams?.get('search') ?? '';

  const [search, setSearch] = useState(urlSearch);
  const [debounced, setDebounced] = useState(urlSearch);
  const [status, setStatus] = useState<'RECORDED' | 'VOIDED' | ''>(
    urlStatus === 'RECORDED' || urlStatus === 'VOIDED' ? urlStatus : '',
  );
  const [method, setMethod] = useState<PaymentMethod | ''>('');
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

  const params: PaymentListParams = {
    page,
    limit: 25,
    ...(debounced && { search: debounced }),
    ...(status && { status }),
    ...(method && { method }),
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['payments', params],
    queryFn: () => listPayments(params),
    placeholderData: (previous) => previous,
  });

  const role = me?.organisation?.role;
  const canView = role ? hasPermission(role, 'payment:view') : true;

  if (role && !canView) return <PermissionDenied />;

  const isFiltered = Boolean(debounced || status || method);

  // Voided payments are excluded from the total: they represent money that was
  // reversed, and including them would overstate what was received.
  const recordedTotal = data?.items
    .filter((p) => p.status === 'RECORDED')
    .reduce((sum, p) => sum + Number(p.amount), 0);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-h1 text-ink">Payments</h1>
          <p className="mt-1 text-body text-ink-muted">
            {data ? `${data.total} ${data.total === 1 ? 'payment' : 'payments'}` : ' '}
          </p>
        </div>
        <p className="text-body text-ink-muted">
          Payments are recorded against an invoice from its detail page.
        </p>
      </header>

      <Card className="flex flex-wrap items-end gap-4 p-4">
        <div className="flex min-w-[240px] flex-1 flex-col gap-2">
          <label htmlFor="payment-search" className="text-body-sm font-medium text-ink">
            Search
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
              aria-hidden="true"
            />
            <Input
              id="payment-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Number, reference or customer"
              className="pl-9"
            />
          </div>
        </div>

        <div className="flex w-[170px] flex-col gap-2">
          <label htmlFor="payment-status" className="text-body-sm font-medium text-ink">
            Status
          </label>
          <Select
            id="payment-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as typeof status);
              setPage(1);
            }}
          >
            <option value="">All</option>
            <option value="RECORDED">Recorded</option>
            <option value="VOIDED">Voided</option>
          </Select>
        </div>

        <div className="flex w-[180px] flex-col gap-2">
          <label htmlFor="payment-method-filter" className="text-body-sm font-medium text-ink">
            Method
          </label>
          <Select
            id="payment-method-filter"
            value={method}
            onChange={(e) => {
              setMethod(e.target.value as PaymentMethod | '');
              setPage(1);
            }}
          >
            <option value="">All methods</option>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
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
            error instanceof ApiRequestError ? error.message : 'We could not load your payments.'
          }
          onRetry={() => refetch()}
        />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          title={isFiltered ? 'No matching payments' : 'No payments recorded'}
          description={
            isFiltered
              ? 'Try a different search or clear the filters.'
              : 'Open a sent invoice and use “Record payment” to log money received.'
          }
          action={
            isFiltered ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch('');
                  setStatus('');
                  setMethod('');
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Link href="/invoices?outstanding=true">
                <Button variant="secondary">View outstanding invoices</Button>
              </Link>
            )
          }
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-md border border-border bg-surface shadow-card">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] border-collapse">
                <caption className="sr-only">Payments</caption>
                <thead>
                  <tr className="border-b border-border bg-canvas">
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Payment
                    </th>
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Date
                    </th>
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Customer
                    </th>
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Applied to
                    </th>
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Method
                    </th>
                    <th scope="col" className="p-4 text-right text-body-sm font-semibold text-ink-secondary">
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((payment) => (
                    <tr key={payment.id} className="border-b border-border last:border-b-0 hover:bg-canvas">
                      <td className="p-4">
                        <span className="text-body font-medium text-ink">
                          {payment.paymentNumber}
                        </span>
                        {payment.status === 'VOIDED' && (
                          <span className="ml-2">
                            <Badge tone="gray">Voided</Badge>
                          </span>
                        )}
                        {payment.reference && (
                          <p className="text-caption text-ink-muted">{payment.reference}</p>
                        )}
                      </td>
                      <td className="p-4 text-body text-ink-secondary">
                        {formatDate(payment.paymentDate)}
                      </td>
                      <td className="p-4 text-body text-ink">
                        {payment.customer ? (
                          <Link
                            href={`/customers/${payment.customer.id}`}
                            className="text-primary hover:underline"
                          >
                            {customerName(payment.customer)}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="p-4 text-body">
                        {payment.allocations && payment.allocations.length > 0 ? (
                          payment.allocations.map((allocation, index) => (
                            <span key={allocation.invoice.id}>
                              {index > 0 && ', '}
                              <Link
                                href={`/invoices/${allocation.invoice.id}`}
                                className="text-primary hover:underline"
                              >
                                {allocation.invoice.invoiceNumber}
                              </Link>
                            </span>
                          ))
                        ) : (
                          <span className="text-ink-muted">—</span>
                        )}
                      </td>
                      <td className="p-4 text-body text-ink-secondary">
                        {paymentMethodLabel(payment.paymentMethod)}
                      </td>
                      <td className="p-4 text-right text-body">
                        <span
                          className={
                            payment.status === 'VOIDED'
                              ? 'text-ink-muted line-through'
                              : 'font-medium text-ink'
                          }
                        >
                          <Money amount={payment.amount} currency={payment.currencyCode} />
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                {recordedTotal !== undefined && (
                  <tfoot>
                    <tr className="border-t border-border-strong bg-canvas">
                      <td colSpan={5} className="p-4 text-right text-body-sm font-medium text-ink-secondary">
                        Recorded on this page
                      </td>
                      <td className="p-4 text-right text-body font-semibold text-ink">
                        <Money
                          amount={recordedTotal.toFixed(4)}
                          currency={data.items[0]?.currencyCode ?? 'INR'}
                        />
                      </td>
                    </tr>
                  </tfoot>
                )}
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
