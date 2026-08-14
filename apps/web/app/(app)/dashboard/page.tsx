'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Plus,
  FileText,
  Receipt,
  Users,
  AlertTriangle,
  ArrowRight,
} from 'lucide-react';
import type { CurrentUserResponse } from '@billing/types';
import { hasPermission } from '@billing/types';
import { apiFetch, ApiRequestError } from '../../../lib/api-client';
import { customerName } from '../../../lib/customers';
import { INVOICE_STATUS_TONE } from '../../../lib/invoices';
import { QUOTATION_STATUS_TONE } from '../../../lib/quotations';
import {
  Button,
  Card,
  Badge,
  Money,
  ErrorState,
  TableSkeleton,
} from '../../../components/ui/primitives';

/** TICKET-039, 040, 041 — dashboard. */

interface DashboardSummary {
  currency: string;
  totals: { totalInvoiced: string; totalPaid: string; outstanding: string; overdue: string };
  counts: {
    outstandingInvoices: number;
    overdueInvoices: number;
    draftInvoices: number;
    openQuotations: number;
  };
  quotationPipeline: {
    openValue: string;
    acceptedValue: string;
    sentCount: number;
    acceptedCount: number;
  };
}

interface RecentCustomer {
  id: string;
  companyName: string | null;
  contactName: string | null;
}

interface DashboardRecent {
  invoices: Array<{
    id: string;
    invoiceNumber: string;
    issueDate: string;
    dueDate: string;
    status: string;
    currencyCode: string;
    totalAmount: string;
    amountDue: string;
    customer: RecentCustomer;
  }>;
  quotations: Array<{
    id: string;
    quotationNumber: string;
    issueDate: string;
    validUntil: string | null;
    status: string;
    currencyCode: string;
    totalAmount: string;
    customer: RecentCustomer;
  }>;
  outstandingInvoices: Array<{
    id: string;
    invoiceNumber: string;
    dueDate: string;
    status: string;
    currencyCode: string;
    amountDue: string;
    customer: RecentCustomer;
  }>;
}

const humanStatus = (s: string) =>
  s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

const isPast = (iso: string) => new Date(iso) < new Date();

export default function DashboardPage() {
  const { data: me } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<CurrentUserResponse>('/auth/me'),
  });

  const summaryQuery = useQuery({
    queryKey: ['dashboard', 'summary'],
    queryFn: () => apiFetch<DashboardSummary>('/dashboard/summary'),
  });

  const recentQuery = useQuery({
    queryKey: ['dashboard', 'recent'],
    queryFn: () => apiFetch<DashboardRecent>('/dashboard/recent'),
  });

  const role = me?.organisation?.role;
  const canCreateInvoice = role ? hasPermission(role, 'invoice:write') : false;
  const canCreateQuotation = role ? hasPermission(role, 'quotation:write') : false;
  const canCreateCustomer = role ? hasPermission(role, 'customer:write') : false;

  if (summaryQuery.isLoading) return <TableSkeleton rows={4} columns={4} />;

  if (summaryQuery.error) {
    return (
      <ErrorState
        message={
          summaryQuery.error instanceof ApiRequestError
            ? summaryQuery.error.message
            : 'We could not load your dashboard.'
        }
        onRetry={() => summaryQuery.refetch()}
      />
    );
  }

  const summary = summaryQuery.data;
  const recent = recentQuery.data;
  if (!summary) return null;

  const currency = summary.currency;
  const nothingYet =
    Number(summary.totals.totalInvoiced) === 0 &&
    summary.counts.draftInvoices === 0 &&
    summary.counts.openQuotations === 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-h1 text-ink">Dashboard</h1>
          <p className="mt-1 text-body text-ink-muted">
            {me?.organisation?.organisationName}
          </p>
        </div>

        {/* TICKET-041 — quick actions, permission-gated. */}
        <div className="flex flex-wrap gap-2">
          {canCreateCustomer && (
            <Link href="/customers/new">
              <Button variant="secondary">
                <Users className="h-4 w-4" aria-hidden="true" />
                Add customer
              </Button>
            </Link>
          )}
          {canCreateQuotation && (
            <Link href="/quotations/new">
              <Button variant="secondary">
                <FileText className="h-4 w-4" aria-hidden="true" />
                New quotation
              </Button>
            </Link>
          )}
          {canCreateInvoice && (
            <Link href="/invoices/new">
              <Button>
                <Plus className="h-4 w-4" aria-hidden="true" />
                New invoice
              </Button>
            </Link>
          )}
        </div>
      </header>

      {nothingYet ? (
        <Card className="flex flex-col items-center gap-3 p-12 text-center">
          <h2 className="text-h3 text-ink">Nothing billed yet</h2>
          <p className="max-w-md text-body text-ink-muted">
            Add a customer, then raise a quotation or invoice. Your totals will appear here as
            soon as you issue something.
          </p>
          {canCreateCustomer && (
            <Link href="/customers/new">
              <Button>Add your first customer</Button>
            </Link>
          )}
        </Card>
      ) : (
        <>
          {/* TICKET-039 — KPI cards. */}
          <section aria-label="Key figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi
              label="Total invoiced"
              value={summary.totals.totalInvoiced}
              currency={currency}
              hint="Issued invoices, excluding drafts and cancelled"
            />
            <Kpi
              label="Total paid"
              value={summary.totals.totalPaid}
              currency={currency}
              tone="success"
              hint="Received against issued invoices"
            />
            <Kpi
              label="Outstanding"
              value={summary.totals.outstanding}
              currency={currency}
              tone={Number(summary.totals.outstanding) > 0 ? 'warning' : 'default'}
              hint={`${summary.counts.outstandingInvoices} ${
                summary.counts.outstandingInvoices === 1 ? 'invoice' : 'invoices'
              } awaiting payment`}
              href="/invoices?outstanding=true"
            />
            <Kpi
              label="Overdue"
              value={summary.totals.overdue}
              currency={currency}
              tone={Number(summary.totals.overdue) > 0 ? 'danger' : 'default'}
              hint={`${summary.counts.overdueInvoices} past the due date`}
              href="/invoices?status=OVERDUE"
            />
          </section>

          {Number(summary.totals.overdue) > 0 && (
            <Card className="flex items-center gap-3 border-danger/30 bg-danger-light">
              <AlertTriangle className="h-5 w-5 shrink-0 text-danger" aria-hidden="true" />
              <p className="flex-1 text-body text-ink">
                <span className="font-medium">
                  <Money amount={summary.totals.overdue} currency={currency} />
                </span>{' '}
                is overdue across {summary.counts.overdueInvoices}{' '}
                {summary.counts.overdueInvoices === 1 ? 'invoice' : 'invoices'}.
              </p>
              <Link href="/invoices?status=OVERDUE">
                <Button variant="secondary">Review</Button>
              </Link>
            </Card>
          )}

          <div className="grid gap-6 lg:grid-cols-3">
            {/* Collections worklist: oldest due first. */}
            <Card className="p-0 lg:col-span-2">
              <div className="flex items-center justify-between border-b border-border p-5">
                <h2 className="text-h4 text-ink">Awaiting payment</h2>
                <Link
                  href="/invoices?outstanding=true"
                  className="inline-flex items-center gap-1 text-body-sm text-primary hover:underline"
                >
                  View all
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </div>

              {!recent ? (
                <p className="p-5 text-body text-ink-muted" role="status">
                  Loading…
                </p>
              ) : recent.outstandingInvoices.length === 0 ? (
                <p className="p-5 text-body text-ink-muted">
                  Nothing outstanding. Every issued invoice is settled.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] border-collapse">
                    <caption className="sr-only">Invoices awaiting payment</caption>
                    <thead>
                      <tr className="border-b border-border bg-canvas">
                        <th scope="col" className="p-4 text-left text-caption font-semibold text-ink-secondary">
                          Invoice
                        </th>
                        <th scope="col" className="p-4 text-left text-caption font-semibold text-ink-secondary">
                          Customer
                        </th>
                        <th scope="col" className="p-4 text-left text-caption font-semibold text-ink-secondary">
                          Due
                        </th>
                        <th scope="col" className="p-4 text-right text-caption font-semibold text-ink-secondary">
                          Balance
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.outstandingInvoices.map((invoice) => (
                        <tr key={invoice.id} className="border-b border-border last:border-b-0">
                          <td className="p-4">
                            <Link
                              href={`/invoices/${invoice.id}`}
                              className="text-body font-medium text-primary hover:underline"
                            >
                              {invoice.invoiceNumber}
                            </Link>
                          </td>
                          <td className="p-4 text-body text-ink">
                            {customerName(invoice.customer)}
                          </td>
                          <td className="p-4 text-body">
                            <span
                              className={
                                isPast(invoice.dueDate)
                                  ? 'font-medium text-danger'
                                  : 'text-ink-secondary'
                              }
                            >
                              {formatDate(invoice.dueDate)}
                            </span>
                          </td>
                          <td className="p-4 text-right text-body font-medium text-ink">
                            <Money amount={invoice.amountDue} currency={invoice.currencyCode} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* Quotation pipeline. */}
            <Card className="lg:col-span-1">
              <h2 className="text-h4 text-ink">Quotation pipeline</h2>
              <dl className="mt-4 flex flex-col gap-4">
                <div>
                  <dt className="text-caption text-ink-muted">Open value</dt>
                  <dd className="text-h3 text-ink">
                    <Money amount={summary.quotationPipeline.openValue} currency={currency} />
                  </dd>
                </div>
                <div>
                  <dt className="text-caption text-ink-muted">
                    Accepted, awaiting conversion
                  </dt>
                  <dd className="text-body-lg font-medium text-success">
                    <Money amount={summary.quotationPipeline.acceptedValue} currency={currency} />
                  </dd>
                </div>
                <div className="flex gap-6 border-t border-border pt-3">
                  <div>
                    <dt className="text-caption text-ink-muted">Sent</dt>
                    <dd className="text-body font-medium text-ink tabular">
                      {summary.quotationPipeline.sentCount}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-caption text-ink-muted">Accepted</dt>
                    <dd className="text-body font-medium text-ink tabular">
                      {summary.quotationPipeline.acceptedCount}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-caption text-ink-muted">Drafts</dt>
                    <dd className="text-body font-medium text-ink tabular">
                      {summary.counts.draftInvoices}
                    </dd>
                  </div>
                </div>
              </dl>
              <Link
                href="/quotations?status=ACCEPTED"
                className="mt-4 inline-flex items-center gap-1 text-body-sm text-primary hover:underline"
              >
                Ready to convert
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </Card>
          </div>

          {/* TICKET-040 — recent documents. */}
          <div className="grid gap-6 lg:grid-cols-2">
            <RecentList
              title="Recent invoices"
              href="/invoices"
              emptyMessage="No invoices yet."
              rows={recent?.invoices.map((invoice) => ({
                id: invoice.id,
                url: `/invoices/${invoice.id}`,
                number: invoice.invoiceNumber,
                customer: customerName(invoice.customer),
                date: invoice.issueDate,
                status: invoice.status,
                tone: INVOICE_STATUS_TONE[invoice.status as keyof typeof INVOICE_STATUS_TONE] ?? 'gray',
                amount: invoice.totalAmount,
                currency: invoice.currencyCode,
              }))}
            />
            <RecentList
              title="Recent quotations"
              href="/quotations"
              emptyMessage="No quotations yet."
              rows={recent?.quotations.map((quotation) => ({
                id: quotation.id,
                url: `/quotations/${quotation.id}`,
                number: quotation.quotationNumber,
                customer: customerName(quotation.customer),
                date: quotation.issueDate,
                status: quotation.status,
                tone:
                  QUOTATION_STATUS_TONE[quotation.status as keyof typeof QUOTATION_STATUS_TONE] ??
                  'gray',
                amount: quotation.totalAmount,
                currency: quotation.currencyCode,
              }))}
            />
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  currency,
  hint,
  tone = 'default',
  href,
}: {
  label: string;
  value: string;
  currency: string;
  hint?: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
  href?: string;
}) {
  const valueClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'danger'
        ? 'text-danger'
        : tone === 'warning'
          ? 'text-warning'
          : 'text-ink';

  const content = (
    <Card className={href ? 'transition-colors hover:border-border-strong' : undefined}>
      <h2 className="text-body-sm font-medium text-ink-secondary">{label}</h2>
      <p className={`mt-2 text-h2 ${valueClass}`}>
        <Money amount={value} currency={currency} />
      </p>
      {hint && <p className="mt-1 text-caption text-ink-muted">{hint}</p>}
    </Card>
  );

  return href ? (
    <Link href={href} className="block">
      {content}
    </Link>
  ) : (
    content
  );
}

interface RecentRow {
  id: string;
  url: string;
  number: string;
  customer: string;
  date: string;
  status: string;
  tone: 'gray' | 'blue' | 'green' | 'red' | 'orange';
  amount: string;
  currency: string;
}

function RecentList({
  title,
  href,
  rows,
  emptyMessage,
}: {
  title: string;
  href: string;
  rows: RecentRow[] | undefined;
  emptyMessage: string;
}) {
  return (
    <Card className="p-0">
      <div className="flex items-center justify-between border-b border-border p-5">
        <h2 className="text-h4 text-ink">{title}</h2>
        <Link href={href} className="inline-flex items-center gap-1 text-body-sm text-primary hover:underline">
          View all
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>

      {!rows ? (
        <p className="p-5 text-body text-ink-muted" role="status">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className="p-5 text-body text-ink-muted">{emptyMessage}</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={row.url}
                className="flex items-center gap-3 p-4 transition-colors hover:bg-canvas"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-body font-medium text-primary">{row.number}</span>
                  <span className="block truncate text-caption text-ink-muted">
                    {row.customer} · {formatDate(row.date)}
                  </span>
                </span>
                <Badge tone={row.tone}>{humanStatus(row.status)}</Badge>
                <span className="shrink-0 text-body text-ink">
                  <Money amount={row.amount} currency={row.currency} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
