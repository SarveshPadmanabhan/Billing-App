'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, Archive, ArchiveRestore } from 'lucide-react';
import type { CurrentUserResponse } from '@billing/types';
import { hasPermission } from '@billing/types';
import { apiFetch, ApiRequestError } from '../../../lib/api-client';
import {
  listCustomers,
  customerName,
  type CustomerListParams,
} from '../../../lib/customers';
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

/**
 * Customer list (TICKET-009, TICKET-012).
 *
 * Covers every state the Frontend Spec §33 requires: loading, empty, error,
 * and permission-denied.
 */
export default function CustomersPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<'active' | 'archived' | 'all'>('active');
  const [page, setPage] = useState(1);

  // Debounce so a keystroke does not fire a request each time; the spec asks
  // for search to feel under 300ms, and this keeps load off the API.
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

  const params: CustomerListParams = { page, limit: 25, status, ...(debounced && { search: debounced }) };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['customers', params],
    queryFn: () => listCustomers(params),
    // Keeps the previous page visible while the next loads, avoiding a
    // flash of skeleton on every pagination click.
    placeholderData: (previous) => previous,
  });

  const role = me?.organisation?.role;
  const canView = role ? hasPermission(role, 'customer:view') : true;
  const canWrite = role ? hasPermission(role, 'customer:write') : false;

  if (role && !canView) return <PermissionDenied />;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-h1 text-ink">Customers</h1>
          <p className="mt-1 text-body text-ink-muted">
            {data ? `${data.total} ${data.total === 1 ? 'customer' : 'customers'}` : ' '}
          </p>
        </div>
        {canWrite && (
          <Link href="/customers/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden="true" />
              New customer
            </Button>
          </Link>
        )}
      </header>

      <Card className="flex flex-wrap items-end gap-4 p-4">
        <div className="flex min-w-[240px] flex-1 flex-col gap-2">
          <label htmlFor="customer-search" className="text-body-sm font-medium text-ink">
            Search
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
              aria-hidden="true"
            />
            <Input
              id="customer-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, email or phone"
              className="pl-9"
            />
          </div>
        </div>

        <div className="flex w-[180px] flex-col gap-2">
          <label htmlFor="customer-status" className="text-body-sm font-medium text-ink">
            Status
          </label>
          <Select
            id="customer-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as typeof status);
              setPage(1);
            }}
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </Select>
        </div>
      </Card>

      {isLoading ? (
        <TableSkeleton rows={6} columns={5} />
      ) : error ? (
        <ErrorState
          message={
            error instanceof ApiRequestError ? error.message : 'We could not load your customers.'
          }
          onRetry={() => refetch()}
        />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          title={debounced ? 'No matching customers' : 'No customers yet'}
          description={
            debounced
              ? `Nothing matched "${debounced}". Try a different search.`
              : 'Add your first customer to start creating quotations and invoices.'
          }
          action={
            debounced ? (
              <Button variant="secondary" onClick={() => setSearch('')}>
                Clear search
              </Button>
            ) : canWrite ? (
              <Link href="/customers/new">
                <Button>Add customer</Button>
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-md border border-border bg-surface shadow-card">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse">
                <caption className="sr-only">Customers</caption>
                <thead>
                  <tr className="border-b border-border bg-canvas">
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Customer
                    </th>
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Email
                    </th>
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Phone
                    </th>
                    {/* Financial values right-aligned (Frontend Spec §5). */}
                    <th scope="col" className="p-4 text-right text-body-sm font-semibold text-ink-secondary">
                      Outstanding
                    </th>
                    <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((customer) => (
                    <tr key={customer.id} className="border-b border-border last:border-b-0 hover:bg-canvas">
                      <td className="p-4">
                        <Link
                          href={`/customers/${customer.id}`}
                          className="text-body font-medium text-primary hover:underline"
                        >
                          {customerName(customer)}
                        </Link>
                        {customer.customerType === 'INDIVIDUAL' && customer.companyName && (
                          <p className="text-caption text-ink-muted">{customer.contactName}</p>
                        )}
                      </td>
                      <td className="p-4 text-body text-ink-secondary">{customer.email ?? '—'}</td>
                      <td className="p-4 text-body text-ink-secondary">{customer.phone ?? '—'}</td>
                      <td className="p-4 text-right text-body text-ink">
                        <Money amount={customer.outstanding ?? '0.0000'} />
                      </td>
                      <td className="p-4">
                        {customer.isArchived ? (
                          <Badge tone="gray">
                            <Archive className="mr-1 h-3 w-3" aria-hidden="true" />
                            Archived
                          </Badge>
                        ) : (
                          <Badge tone="green">
                            <ArchiveRestore className="mr-1 h-3 w-3" aria-hidden="true" />
                            Active
                          </Badge>
                        )}
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
