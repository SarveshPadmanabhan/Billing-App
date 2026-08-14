'use client';

import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { apiFetch } from '../../../../lib/api-client';
import { createInvoice, emptyInvoiceForm, type InvoiceFormValues } from '../../../../lib/invoices';
import { InvoiceForm } from '../../../../components/documents/invoice-form';
import { usePermissionGuard } from '../../../../lib/use-permission-guard';

/** TICKET-024 — create invoice. */
export default function NewInvoicePage() {
  const denied = usePermissionGuard('invoice:write');
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: organisation } = useQuery({
    queryKey: ['organisation', 'current'],
    queryFn: () =>
      apiFetch<{
        currencyCode: string;
        settings: { defaultTaxRate: string; defaultPaymentTermsDays: number } | null;
      }>('/organisations/current'),
  });

  // Checked before every other early return: a denied user should see the
  // denial immediately, not a loading skeleton or a form they cannot submit.
  // Placed after the hooks above so hook order stays stable across renders.
  if (denied) return denied;

  async function handleSubmit(values: InvoiceFormValues) {
    const invoice = await createInvoice(values);
    await queryClient.invalidateQueries({ queryKey: ['invoices'] });
    router.push(`/invoices/${invoice.id}`);
  }

  // Wait for settings so the tax rate and due date are correct on first paint.
  if (!organisation) {
    return <p className="text-body text-ink-muted">Loading…</p>;
  }

  const rawTax = organisation.settings?.defaultTaxRate ?? '0';
  const defaultTaxRate = rawTax.includes('.')
    ? rawTax.replace(/0+$/, '').replace(/\.$/, '')
    : rawTax;
  const termsDays = organisation.settings?.defaultPaymentTermsDays ?? 30;

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link
          href="/invoices"
          className="inline-flex items-center gap-1 text-body-sm text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Invoices
        </Link>
        <h1 className="mt-2 text-h1 text-ink">New invoice</h1>
        <p className="mt-1 text-body text-ink-muted">
          The number is assigned automatically when you save.
        </p>
      </div>

      <InvoiceForm
        initialValues={emptyInvoiceForm(defaultTaxRate, termsDays)}
        currency={organisation.currencyCode}
        submitLabel="Save draft"
        onSubmit={handleSubmit}
        onCancel={() => router.push('/invoices')}
      />
    </div>
  );
}
