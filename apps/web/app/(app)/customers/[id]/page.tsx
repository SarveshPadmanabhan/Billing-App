'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Pencil, Archive, ArchiveRestore } from 'lucide-react';
import type { CurrentUserResponse } from '@billing/types';
import { hasPermission } from '@billing/types';
import { apiFetch, ApiRequestError } from '../../../../lib/api-client';
import {
  getCustomerBillingHistory,
  archiveCustomer,
  restoreCustomer,
  customerName,
} from '../../../../lib/customers';
import {
  Button,
  Card,
  Badge,
  Money,
  Modal,
  Input,
  ErrorState,
  TableSkeleton,
  type BadgeTone,
} from '../../../../components/ui/primitives';

/** Status colours per Frontend Spec §10. Text always carries the meaning too. */
const STATUS_TONES: Record<string, BadgeTone> = {
  DRAFT: 'gray',
  SENT: 'blue',
  ACCEPTED: 'green',
  REJECTED: 'red',
  EXPIRED: 'orange',
  CONVERTED: 'green',
  CANCELLED: 'gray',
  PARTIALLY_PAID: 'blue',
  PAID: 'green',
  OVERDUE: 'red',
};

const humanStatus = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

/** TICKET-013 — customer detail and billing history. */
export default function CustomerDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = String(params?.id ?? '');

  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveReason, setArchiveReason] = useState('');
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: me } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<CurrentUserResponse>('/auth/me'),
  });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['customers', id, 'billing-history'],
    queryFn: () => getCustomerBillingHistory(id),
    enabled: Boolean(id),
  });

  const role = me?.organisation?.role;
  const canWrite = role ? hasPermission(role, 'customer:write') : false;
  const canArchive = role ? hasPermission(role, 'customer:archive') : false;

  async function runAction(action: () => Promise<unknown>) {
    setWorking(true);
    setActionError(null);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
      setArchiveOpen(false);
      setArchiveReason('');
    } catch (err) {
      setActionError(
        err instanceof ApiRequestError ? err.message : 'Something went wrong. Please try again.',
      );
    } finally {
      setWorking(false);
    }
  }

  if (isLoading) return <TableSkeleton rows={6} columns={4} />;

  if (error) {
    const notFound = error instanceof ApiRequestError && error.status === 404;
    return (
      <ErrorState
        message={notFound ? 'This customer could not be found.' : 'We could not load this customer.'}
        onRetry={notFound ? undefined : () => refetch()}
      />
    );
  }

  if (!data) return null;

  const { customer, totals, quotations, invoices, payments } = data;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/customers"
          className="inline-flex items-center gap-1 text-body-sm text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Customers
        </Link>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-h1 text-ink">{customerName(customer)}</h1>
              {customer.isArchived && <Badge tone="gray">Archived</Badge>}
            </div>
            <p className="mt-1 text-body text-ink-muted">
              {customer.customerType === 'COMPANY' ? 'Company' : 'Individual'}
              {customer.taxNumber && ` · ${customer.taxNumber}`}
            </p>
          </div>

          <div className="flex gap-2">
            {canWrite && !customer.isArchived && (
              <Link href={`/customers/${id}/edit`}>
                <Button variant="secondary">
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  Edit
                </Button>
              </Link>
            )}
            {canArchive &&
              (customer.isArchived ? (
                <Button
                  variant="secondary"
                  loading={working}
                  onClick={() => runAction(() => restoreCustomer(id))}
                >
                  <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
                  Restore
                </Button>
              ) : (
                <Button variant="destructive" onClick={() => setArchiveOpen(true)}>
                  <Archive className="h-4 w-4" aria-hidden="true" />
                  Archive
                </Button>
              ))}
          </div>
        </div>
      </div>

      {actionError && (
        <div role="alert" className="rounded-sm bg-danger-light p-3 text-body-sm text-danger">
          {actionError}
        </div>
      )}

      {/* Totals come from stored records, computed server-side (TICKET-013). */}
      <section aria-label="Financial summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Total quoted', value: totals.totalQuoted },
          { label: 'Total invoiced', value: totals.totalInvoiced },
          { label: 'Total paid', value: totals.totalPaid },
          { label: 'Outstanding', value: totals.outstanding, emphasise: true },
        ].map((kpi) => (
          <Card key={kpi.label}>
            <h2 className="text-body-sm font-medium text-ink-secondary">{kpi.label}</h2>
            <p
              className={`mt-2 text-h3 ${
                kpi.emphasise && Number(kpi.value) > 0 ? 'text-danger' : 'text-ink'
              }`}
            >
              <Money amount={kpi.value} />
            </p>
          </Card>
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <h2 className="text-h4 text-ink">Contact</h2>
          <dl className="mt-4 flex flex-col gap-3 text-body">
            <Detail label="Email" value={customer.email} />
            <Detail label="Phone" value={customer.phone} />
            <Detail
              label="Billing address"
              value={
                [
                  customer.billingAddressLine1,
                  customer.billingAddressLine2,
                  customer.billingCity,
                  customer.billingState,
                  customer.billingPostalCode,
                  customer.billingCountryCode,
                ]
                  .filter(Boolean)
                  .join(', ') || null
              }
            />
            {customer.notes && <Detail label="Notes" value={customer.notes} />}
          </dl>
        </Card>

        <div className="flex flex-col gap-6 lg:col-span-2">
          <HistoryTable
            title="Invoices"
            emptyMessage="No invoices yet."
            headers={['Number', 'Date', 'Status', 'Total', 'Due']}
            rows={invoices.map((inv) => [
              <Link key="n" href={`/invoices/${inv.id}`} className="text-primary hover:underline">
                {inv.invoiceNumber}
              </Link>,
              formatDate(inv.issueDate),
              <Badge key="s" tone={STATUS_TONES[inv.status] ?? 'gray'}>
                {humanStatus(inv.status)}
              </Badge>,
              <Money key="t" amount={inv.totalAmount} currency={inv.currencyCode} />,
              <Money key="d" amount={inv.amountDue} currency={inv.currencyCode} />,
            ])}
            numericFrom={3}
          />

          <HistoryTable
            title="Quotations"
            emptyMessage="No quotations yet."
            headers={['Number', 'Date', 'Status', 'Total']}
            rows={quotations.map((q) => [
              <Link key="n" href={`/quotations/${q.id}`} className="text-primary hover:underline">
                {q.quotationNumber}
              </Link>,
              formatDate(q.issueDate),
              <Badge key="s" tone={STATUS_TONES[q.status] ?? 'gray'}>
                {humanStatus(q.status)}
              </Badge>,
              <Money key="t" amount={q.totalAmount} currency={q.currencyCode} />,
            ])}
            numericFrom={3}
          />

          <HistoryTable
            title="Payments"
            emptyMessage="No payments recorded."
            headers={['Number', 'Date', 'Method', 'Amount']}
            rows={payments.map((p) => [
              p.paymentNumber,
              formatDate(p.paymentDate),
              humanStatus(p.paymentMethod),
              <Money key="a" amount={p.amount} currency={p.currencyCode} />,
            ])}
            numericFrom={3}
          />
        </div>
      </div>

      <Modal
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        title="Archive this customer?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setArchiveOpen(false)} disabled={working}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={working}
              onClick={() => runAction(() => archiveCustomer(id, archiveReason))}
            >
              Archive customer
            </Button>
          </>
        }
      >
        <p>
          {customerName(customer)} will be hidden from the active list. Existing quotations,
          invoices and payments are kept and remain viewable.
        </p>
        <div className="mt-4">
          <label htmlFor="archive-reason" className="text-body-sm font-medium text-ink">
            Reason (optional)
          </label>
          <Input
            id="archive-reason"
            value={archiveReason}
            onChange={(e) => setArchiveReason(e.target.value)}
            className="mt-2"
          />
        </div>
      </Modal>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-caption text-ink-muted">{label}</dt>
      <dd className="text-body text-ink">{value ?? '—'}</dd>
    </div>
  );
}

function HistoryTable({
  title,
  headers,
  rows,
  emptyMessage,
  numericFrom,
}: {
  title: string;
  headers: string[];
  rows: React.ReactNode[][];
  emptyMessage: string;
  /** Column index from which values are financial and right-aligned. */
  numericFrom: number;
}) {
  return (
    <Card className="p-0">
      <h2 className="border-b border-border p-5 text-h4 text-ink">{title}</h2>
      {rows.length === 0 ? (
        <p className="p-5 text-body text-ink-muted">{emptyMessage}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="border-b border-border bg-canvas">
                {headers.map((header, index) => (
                  <th
                    key={header}
                    scope="col"
                    className={`p-4 text-body-sm font-semibold text-ink-secondary ${
                      index >= numericFrom ? 'text-right' : 'text-left'
                    }`}
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-border last:border-b-0">
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className={`p-4 text-body text-ink ${
                        cellIndex >= numericFrom ? 'text-right' : 'text-left'
                      }`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
