'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import type { CurrentUserResponse } from '@billing/types';
import { hasPermission } from '@billing/types';
import { apiFetch, ApiRequestError } from '../../../lib/api-client';
import {
  Button,
  Card,
  Money,
  Select,
  Input,
  Field,
  EmptyState,
  ErrorState,
  PermissionDenied,
  TableSkeleton,
} from '../../../components/ui/primitives';

/** Reports: aging and revenue by month. Figures come from the API, never computed here. */

interface AgingRow {
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
}

interface AgingReport {
  asOf: string;
  currencyCode: string;
  rows: AgingRow[];
  totals: Omit<AgingRow, 'customerId' | 'customerName' | 'invoiceCount' | 'oldestDueDate'>;
}

interface RevenueReport {
  currencyCode: string;
  from: string;
  to: string;
  months: Array<{ month: string; invoiced: string; collected: string; invoiceCount: number }>;
  totals: { invoiced: string; collected: string; invoiceCount: number };
}

// Same-origin when unset; see lib/api-client.ts for why.
const API_BASE = `${(process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '')}/api/v1`;

const monthLabel = (key: string) => {
  const [y, m] = key.split('-');
  return new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleDateString('en-GB', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export default function ReportsPage() {
  const [months, setMonths] = useState('12');
  // Empty means "use the preset". Only a complete pair is sent — a half-filled
  // range would silently report something other than what is on screen.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const usingDates = Boolean(from && to);
  const revenueQuery = usingDates
    ? `from=${from}&to=${to}`
    : `months=${months}`;

  const { data: me } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<CurrentUserResponse>('/auth/me'),
  });

  const aging = useQuery({
    queryKey: ['reports', 'aging'],
    queryFn: () => apiFetch<AgingReport>('/reports/aging'),
  });

  const revenue = useQuery({
    queryKey: ['reports', 'revenue', revenueQuery],
    queryFn: () => apiFetch<RevenueReport>(`/reports/revenue?${revenueQuery}`),
    placeholderData: (previous) => previous,
  });

  const role = me?.organisation?.role;
  if (role && !hasPermission(role, 'report:view')) return <PermissionDenied />;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-h1 text-ink">Reports</h1>
        <p className="mt-1 text-body text-ink-muted">
          Figures for {me?.organisation?.companyName ?? 'this company'}, calculated from invoices
          and payments each time this page loads.
        </p>
      </header>

      {/* --- Aging ------------------------------------------------------- */}
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-h4 text-ink">Outstanding by age</h2>
            <p className="mt-1 text-body-sm text-ink-muted">
              Unpaid balances grouped by how long they are past their due date
              {aging.data ? ` — as at ${formatDate(aging.data.asOf)}` : ''}.
            </p>
          </div>
          {/* A plain link, not fetch(): the browser handles the download and the
              session cookie travels with it. */}
          <a href={`${API_BASE}/reports/aging.csv`} download>
            <Button variant="secondary">
              <Download className="h-4 w-4" aria-hidden="true" />
              CSV
            </Button>
          </a>
        </div>

        {aging.isLoading ? (
          <TableSkeleton rows={4} columns={7} />
        ) : aging.error ? (
          <ErrorState
            message={
              aging.error instanceof ApiRequestError
                ? aging.error.message
                : 'We could not load this report.'
            }
            onRetry={() => aging.refetch()}
          />
        ) : !aging.data || aging.data.rows.length === 0 ? (
          <EmptyState
            title="Nothing outstanding"
            description="Every issued invoice has been paid in full."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse">
              <caption className="sr-only">Outstanding balances by age</caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="p-3 text-left text-body-sm font-semibold text-ink-secondary">
                    Customer
                  </th>
                  <th scope="col" className="p-3 text-right text-body-sm font-semibold text-ink-secondary">
                    Not yet due
                  </th>
                  <th scope="col" className="p-3 text-right text-body-sm font-semibold text-ink-secondary">
                    1–30 days
                  </th>
                  <th scope="col" className="p-3 text-right text-body-sm font-semibold text-ink-secondary">
                    31–60 days
                  </th>
                  <th scope="col" className="p-3 text-right text-body-sm font-semibold text-ink-secondary">
                    61–90 days
                  </th>
                  <th scope="col" className="p-3 text-right text-body-sm font-semibold text-ink-secondary">
                    90+ days
                  </th>
                  <th scope="col" className="p-3 text-right text-body-sm font-semibold text-ink-secondary">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {aging.data.rows.map((row) => (
                  <tr key={row.customerId} className="border-b border-border last:border-b-0">
                    <td className="p-3">
                      <span className="text-body text-ink">{row.customerName}</span>
                      <span className="ml-2 text-caption text-ink-muted">
                        {row.invoiceCount} {row.invoiceCount === 1 ? 'invoice' : 'invoices'}
                      </span>
                    </td>
                    <Cell value={row.current} currency={aging.data.currencyCode} />
                    <Cell value={row.days1To30} currency={aging.data.currencyCode} overdue />
                    <Cell value={row.days31To60} currency={aging.data.currencyCode} overdue />
                    <Cell value={row.days61To90} currency={aging.data.currencyCode} overdue />
                    <Cell value={row.days90Plus} currency={aging.data.currencyCode} overdue />
                    <td className="p-3 text-right text-body font-medium text-ink">
                      <Money amount={row.total} currency={aging.data.currencyCode} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border-strong">
                  <td className="p-3 text-body font-semibold text-ink">Total</td>
                  <Cell value={aging.data.totals.current} currency={aging.data.currencyCode} bold />
                  <Cell value={aging.data.totals.days1To30} currency={aging.data.currencyCode} bold />
                  <Cell value={aging.data.totals.days31To60} currency={aging.data.currencyCode} bold />
                  <Cell value={aging.data.totals.days61To90} currency={aging.data.currencyCode} bold />
                  <Cell value={aging.data.totals.days90Plus} currency={aging.data.currencyCode} bold />
                  <td className="p-3 text-right text-body font-semibold text-ink">
                    <Money amount={aging.data.totals.total} currency={aging.data.currencyCode} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {/* --- Revenue ----------------------------------------------------- */}
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-h4 text-ink">Revenue by month</h2>
            <p className="mt-1 text-body-sm text-ink-muted">
              Invoiced is what was billed that month; collected is when the money actually arrived.
              They are not expected to match — an invoice issued in one month is often paid in
              another.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <Field label="Period" htmlFor="months">
                <Select
                  id="months"
                  value={months}
                  disabled={usingDates}
                  onChange={(e) => setMonths(e.target.value)}
                >
                  <option value="6">Last 6 months</option>
                  <option value="12">Last 12 months</option>
                  <option value="24">Last 24 months</option>
                </Select>
              </Field>
            </div>

            <div className="w-44">
              <Field label="From" htmlFor="revenue-from">
                <Input
                  id="revenue-from"
                  type="date"
                  value={from}
                  max={to || undefined}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </Field>
            </div>
            <div className="w-44">
              <Field label="To" htmlFor="revenue-to">
                <Input
                  id="revenue-to"
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={(e) => setTo(e.target.value)}
                />
              </Field>
            </div>

            {(from || to) && (
              <Button
                variant="ghost"
                onClick={() => {
                  setFrom('');
                  setTo('');
                }}
              >
                Clear dates
              </Button>
            )}

            <a href={`${API_BASE}/reports/revenue.csv?${revenueQuery}`} download>
              <Button variant="secondary">
                <Download className="h-4 w-4" aria-hidden="true" />
                CSV
              </Button>
            </a>
          </div>
        </div>

        {Boolean(from) !== Boolean(to) && (
          <p className="text-body-sm text-warning">
            Pick both a start and an end date to filter by range — showing the selected period
            until then.
          </p>
        )}

        {revenue.isLoading ? (
          <TableSkeleton rows={6} columns={4} />
        ) : revenue.error ? (
          <ErrorState
            message={
              revenue.error instanceof ApiRequestError
                ? revenue.error.message
                : 'We could not load this report.'
            }
            onRetry={() => revenue.refetch()}
          />
        ) : !revenue.data ? null : (
          <>
            <RevenueChart data={revenue.data} />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse">
                <caption className="sr-only">Revenue by month</caption>
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className="p-3 text-left text-body-sm font-semibold text-ink-secondary">
                      Month
                    </th>
                    <th scope="col" className="p-3 text-right text-body-sm font-semibold text-ink-secondary">
                      Invoices
                    </th>
                    <th scope="col" className="p-3 text-right text-body-sm font-semibold text-ink-secondary">
                      Invoiced
                    </th>
                    <th scope="col" className="p-3 text-right text-body-sm font-semibold text-ink-secondary">
                      Collected
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {revenue.data.months.map((m) => (
                    <tr key={m.month} className="border-b border-border last:border-b-0">
                      <td className="p-3 text-body text-ink">{monthLabel(m.month)}</td>
                      <td className="p-3 text-right text-body text-ink-muted">{m.invoiceCount}</td>
                      <td className="p-3 text-right text-body text-ink">
                        <Money amount={m.invoiced} currency={revenue.data.currencyCode} />
                      </td>
                      <td className="p-3 text-right text-body text-success">
                        <Money amount={m.collected} currency={revenue.data.currencyCode} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border-strong">
                    <td className="p-3 text-body font-semibold text-ink">Total</td>
                    <td className="p-3 text-right text-body font-semibold text-ink">
                      {revenue.data.totals.invoiceCount}
                    </td>
                    <td className="p-3 text-right text-body font-semibold text-ink">
                      <Money amount={revenue.data.totals.invoiced} currency={revenue.data.currencyCode} />
                    </td>
                    <td className="p-3 text-right text-body font-semibold text-success">
                      <Money amount={revenue.data.totals.collected} currency={revenue.data.currencyCode} />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function Cell({
  value,
  currency,
  overdue = false,
  bold = false,
}: {
  value: string;
  currency: string;
  overdue?: boolean;
  bold?: boolean;
}) {
  const isZero = Number(value) === 0;
  return (
    <td className="p-3 text-right text-body">
      <span
        className={
          isZero
            ? 'text-ink-muted'
            : overdue
              ? `text-danger${bold ? ' font-semibold' : ''}`
              : `text-ink${bold ? ' font-semibold' : ''}`
        }
      >
        {isZero ? '—' : <Money amount={value} currency={currency} />}
      </span>
    </td>
  );
}

/**
 * Bar chart, drawn with divs rather than a charting library.
 *
 * Two bars per month keeps the invoiced/collected distinction visible, which
 * is the whole point of the report. Every value is also in the table below, so
 * the chart is decoration — screen readers get the table.
 */
function RevenueChart({ data }: { data: RevenueReport }) {
  const peak = data.months.reduce(
    (max, m) => Math.max(max, Number(m.invoiced), Number(m.collected)),
    0,
  );
  if (peak === 0) {
    return (
      <p className="py-6 text-center text-body-sm text-ink-muted">
        No invoiced or collected amounts in this period.
      </p>
    );
  }

  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      <div className="flex items-end gap-1 overflow-x-auto pb-1" style={{ height: 160 }}>
        {data.months.map((m) => (
          <div key={m.month} className="flex min-w-[44px] flex-1 flex-col items-center gap-1">
            <div className="flex h-full w-full items-end justify-center gap-0.5">
              <div
                className="w-1/2 rounded-t-sm bg-primary"
                style={{ height: `${(Number(m.invoiced) / peak) * 100}%` }}
                title={`Invoiced ${m.invoiced}`}
              />
              <div
                className="w-1/2 rounded-t-sm bg-success"
                style={{ height: `${(Number(m.collected) / peak) * 100}%` }}
                title={`Collected ${m.collected}`}
              />
            </div>
            <span className="whitespace-nowrap text-caption text-ink-muted">
              {monthLabel(m.month).split(' ')[0]}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-4 text-caption text-ink-muted">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm bg-primary" /> Invoiced
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm bg-success" /> Collected
        </span>
      </div>
    </div>
  );
}
