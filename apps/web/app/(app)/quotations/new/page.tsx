'use client';

import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import type { CurrentUserResponse } from '@billing/types';
import { apiFetch } from '../../../../lib/api-client';
import { createQuotation, emptyQuotationForm, type QuotationFormValues } from '../../../../lib/quotations';
import { QuotationForm } from '../../../../components/documents/quotation-form';

/** TICKET-016 — create quotation. */
export default function NewQuotationPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: me } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<CurrentUserResponse>('/auth/me'),
  });

  // Organisation settings supply the default tax rate; falling back to 0 is
  // safe because the server recomputes from whatever is submitted.
  const { data: organisation } = useQuery({
    queryKey: ['organisation', 'current'],
    queryFn: () =>
      apiFetch<{ currencyCode: string; settings: { defaultTaxRate: string } | null }>(
        '/organisations/current',
      ),
  });

  async function handleSubmit(values: QuotationFormValues) {
    const quotation = await createQuotation(values);
    await queryClient.invalidateQueries({ queryKey: ['quotations'] });
    router.push(`/quotations/${quotation.id}`);
  }

  // Wait for settings so the tax-rate default is right on first paint rather
  // than flashing 0 and then changing under the user.
  if (!organisation) {
    return <p className="text-body text-ink-muted">Loading…</p>;
  }

  const defaultTaxRate = organisation.settings?.defaultTaxRate ?? '0';
  const trimmed = defaultTaxRate.includes('.')
    ? defaultTaxRate.replace(/0+$/, '').replace(/\.$/, '')
    : defaultTaxRate;

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link
          href="/quotations"
          className="inline-flex items-center gap-1 text-body-sm text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Quotations
        </Link>
        <h1 className="mt-2 text-h1 text-ink">New quotation</h1>
        <p className="mt-1 text-body text-ink-muted">
          The number is assigned automatically when you save.
        </p>
      </div>

      <QuotationForm
        initialValues={emptyQuotationForm(trimmed)}
        currency={organisation.currencyCode}
        submitLabel="Save draft"
        onSubmit={handleSubmit}
        onCancel={() => router.push('/quotations')}
      />
    </div>
  );
}
