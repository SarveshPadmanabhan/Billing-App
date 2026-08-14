'use client';

import { useRouter, useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import {
  getQuotation,
  updateQuotation,
  quotationToForm,
  type QuotationFormValues,
} from '../../../../../lib/quotations';
import { QuotationForm } from '../../../../../components/documents/quotation-form';
import { Card, ErrorState, TableSkeleton } from '../../../../../components/ui/primitives';
import { ApiRequestError } from '../../../../../lib/api-client';
import { usePermissionGuard } from '../../../../../lib/use-permission-guard';

/** TICKET-018 — edit a DRAFT quotation. */
export default function EditQuotationPage() {
  const denied = usePermissionGuard('quotation:write');
  const router = useRouter();
  const params = useParams();
  const queryClient = useQueryClient();
  const id = String(params?.id ?? '');

  const { data: quotation, isLoading, error, refetch } = useQuery({
    queryKey: ['quotations', id],
    queryFn: () => getQuotation(id),
    enabled: Boolean(id),
  });

  // Checked before every other early return: a denied user should see the
  // denial immediately, not a loading skeleton or a form they cannot submit.
  // Placed after the hooks above so hook order stays stable across renders.
  if (denied) return denied;

  async function handleSubmit(values: QuotationFormValues) {
    // Send the version the form was loaded with, so a concurrent edit is
    // rejected rather than silently overwritten (Security Doc §24).
    await updateQuotation(id, values, quotation?.version);
    await queryClient.invalidateQueries({ queryKey: ['quotations'] });
    router.push(`/quotations/${id}`);
  }

  if (isLoading) return <TableSkeleton rows={6} columns={3} />;

  if (error) {
    const missing = error instanceof ApiRequestError && error.status === 404;
    return (
      <ErrorState
        message={missing ? 'This quotation could not be found.' : 'We could not load this quotation.'}
        onRetry={missing ? undefined : () => refetch()}
      />
    );
  }

  if (!quotation) return null;

  // Only drafts are editable. Reaching this page for anything else means a
  // stale link or a status change in another tab.
  if (quotation.status !== 'DRAFT') {
    return (
      <Card>
        <h1 className="text-h3 text-ink">This quotation can no longer be edited</h1>
        <p className="mt-2 text-body text-ink-muted">
          {quotation.quotationNumber} is {quotation.status.toLowerCase()}. Only draft quotations can
          be changed — duplicate it if you need a revised version.
        </p>
        <Link
          href={`/quotations/${id}`}
          className="mt-4 inline-block text-body text-primary hover:underline"
        >
          Back to quotation
        </Link>
      </Card>
    );
  }

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link
          href={`/quotations/${id}`}
          className="inline-flex items-center gap-1 text-body-sm text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          {quotation.quotationNumber}
        </Link>
        <h1 className="mt-2 text-h1 text-ink">Edit quotation</h1>
        <p className="mt-1 text-body text-ink-muted">
          {quotation.quotationNumber} · the number does not change.
        </p>
      </div>

      <QuotationForm
        initialValues={quotationToForm(quotation)}
        currency={quotation.currencyCode}
        submitLabel="Save changes"
        onSubmit={handleSubmit}
        onCancel={() => router.push(`/quotations/${id}`)}
      />
    </div>
  );
}
