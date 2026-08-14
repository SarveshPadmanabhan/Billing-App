'use client';

import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { listCustomers, customerName } from '../../lib/customers';
import { Button, Card, Input, Select } from '../ui/primitives';

/**
 * Combined document filters (TICKET-037).
 *
 * Shared by the quotation and invoice lists so the two behave identically —
 * a user who has learned one already knows the other, and a fix applies to
 * both. Filters compose: status AND date range AND customer are all applied
 * together by the API.
 */

/**
 * The filters every document list shares.
 *
 * The index signature lets a list carry additional string filters of its own
 * (invoices add `outstanding`) while still using this component and the URL
 * sync hook unchanged.
 */
export interface DocumentFilterValues {
  search: string;
  status: string;
  customerId: string;
  dateFrom: string;
  dateTo: string;
  [key: string]: string;
}

export const emptyFilters: DocumentFilterValues = {
  search: '',
  status: '',
  customerId: '',
  dateFrom: '',
  dateTo: '',
};

/** True when anything is narrowing the list. Drives the "Clear" affordance. */
export const hasActiveFilters = (values: DocumentFilterValues): boolean =>
  Object.values(values).some((value) => value !== '');

export function DocumentFilters({
  values,
  onChange,
  statuses,
  searchPlaceholder,
  /** Rendered beside the filters, e.g. an "Outstanding only" checkbox. */
  extra,
}: {
  values: DocumentFilterValues;
  onChange: (values: DocumentFilterValues) => void;
  statuses: ReadonlyArray<{ value: string; label: string }>;
  searchPlaceholder: string;
  extra?: React.ReactNode;
}) {
  // Only active customers are offered: archived ones can hold historical
  // documents, but filtering by them is a rare enough case not to clutter
  // the picker. The API accepts any customer id regardless.
  const { data: customers } = useQuery({
    queryKey: ['customers', { status: 'active', limit: 100, forFilter: true }],
    queryFn: () =>
      listCustomers({ status: 'active', limit: 100, sort: 'companyName', direction: 'asc' }),
  });

  const set = <K extends keyof DocumentFilterValues>(key: K, value: DocumentFilterValues[K]) =>
    onChange({ ...values, [key]: value });

  // A reversed range returns nothing, which looks like a bug rather than a
  // mistake — flag it inline instead.
  const invalidRange = Boolean(values.dateFrom && values.dateTo && values.dateTo < values.dateFrom);

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-[220px] flex-1 flex-col gap-2">
          <label htmlFor="filter-search" className="text-body-sm font-medium text-ink">
            Search
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
              aria-hidden="true"
            />
            <Input
              id="filter-search"
              type="search"
              value={values.search}
              onChange={(e) => set('search', e.target.value)}
              placeholder={searchPlaceholder}
              className="pl-9"
            />
          </div>
        </div>

        <div className="flex w-[180px] flex-col gap-2">
          <label htmlFor="filter-status" className="text-body-sm font-medium text-ink">
            Status
          </label>
          <Select
            id="filter-status"
            value={values.status}
            onChange={(e) => set('status', e.target.value)}
          >
            <option value="">All statuses</option>
            {statuses.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex w-[220px] flex-col gap-2">
          <label htmlFor="filter-customer" className="text-body-sm font-medium text-ink">
            Customer
          </label>
          <Select
            id="filter-customer"
            value={values.customerId}
            onChange={(e) => set('customerId', e.target.value)}
          >
            <option value="">All customers</option>
            {customers?.items.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customerName(customer)}
              </option>
            ))}
          </Select>
        </div>

        {extra}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex w-[180px] flex-col gap-2">
          <label htmlFor="filter-date-from" className="text-body-sm font-medium text-ink">
            From
          </label>
          <Input
            id="filter-date-from"
            type="date"
            value={values.dateFrom}
            max={values.dateTo || undefined}
            onChange={(e) => set('dateFrom', e.target.value)}
          />
        </div>

        <div className="flex w-[180px] flex-col gap-2">
          <label htmlFor="filter-date-to" className="text-body-sm font-medium text-ink">
            To
          </label>
          <Input
            id="filter-date-to"
            type="date"
            value={values.dateTo}
            min={values.dateFrom || undefined}
            invalid={invalidRange}
            onChange={(e) => set('dateTo', e.target.value)}
          />
        </div>

        {hasActiveFilters(values) && (
          <Button variant="ghost" onClick={() => onChange(emptyFilters)}>
            <X className="h-4 w-4" aria-hidden="true" />
            Clear filters
          </Button>
        )}
      </div>

      {invalidRange && (
        <p role="alert" className="text-caption text-danger">
          The “to” date is before the “from” date, so nothing will match.
        </p>
      )}
    </Card>
  );
}
