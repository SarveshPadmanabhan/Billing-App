'use client';

import { useRouter, useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import {
  getInvoice,
  updateInvoice,
  invoiceToForm,
  type InvoiceFormValues,
} from '../../../../../lib/invoices';
import { InvoiceForm } from '../../../../../components/documents/invoice-form';
import { Card, ErrorState, TableSkeleton } from '../../../../../components/ui/primitives';
import { ApiRequestError } from '../../../../../lib/api-client';

/** TICKET-027 — edit a DRAFT invoice. */
export default function EditInvoicePage() {
  const router = useRouter();
  const params = useParams();
  const queryClient = useQueryClient();
  const id = String(params?.id ?? '');

  const { data: invoice, isLoading, error, refetch } = useQuery({
    queryKey: ['invoices', id],
    queryFn: () => getInvoice(id),
    enabled: Boolean(id),
  });

  async function handleSubmit(values: InvoiceFormValues) {
    await updateInvoice(id, values, invoice?.version);
    await queryClient.invalidateQueries({ queryKey: ['invoices'] });
    router.push(`/invoices/${id}`);
  }

  if (isLoading) return <TableSkeleton rows={6} columns={3} />;

  if (error) {
    const missing = error instanceof ApiRequestError && error.status === 404;
    return (
      <ErrorState
        message={missing ? 'This invoice could not be found.' : 'We could not load this invoice.'}
        onRetry={missing ? undefined : () => refetch()}
      />
    );
  }

  if (!invoice) return null;

  // Only drafts are editable. An issued invoice is a claim the customer holds
  // a copy of; changing it silently would break that.
  if (invoice.status !== 'DRAFT') {
    return (
      <Card>
        <h1 className="text-h3 text-ink">This invoice can no longer be edited</h1>
        <p className="mt-2 text-body text-ink-muted">
          {invoice.invoiceNumber} is {invoice.status.replace(/_/g, ' ').toLowerCase()}. Issued
          invoices cannot be changed — duplicate it if you need a revised version, or cancel it and
          raise a new one.
        </p>
        <Link
          href={`/invoices/${id}`}
          className="mt-4 inline-block text-body text-primary hover:underline"
        >
          Back to invoice
        </Link>
      </Card>
    );
  }

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link
          href={`/invoices/${id}`}
          className="inline-flex items-center gap-1 text-body-sm text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          {invoice.invoiceNumber}
        </Link>
        <h1 className="mt-2 text-h1 text-ink">Edit invoice</h1>
        <p className="mt-1 text-body text-ink-muted">
          {invoice.invoiceNumber} · the number does not change.
        </p>
      </div>

      <InvoiceForm
        initialValues={invoiceToForm(invoice)}
        currency={invoice.currencyCode}
        submitLabel="Save changes"
        onSubmit={handleSubmit}
        onCancel={() => router.push(`/invoices/${id}`)}
      />
    </div>
  );
}
