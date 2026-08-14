'use client';

import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { createCustomer, type CustomerFormValues } from '../../../../lib/customers';
import { CustomerForm, emptyCustomerForm } from '../../../../components/customers/customer-form';
import { usePermissionGuard } from '../../../../lib/use-permission-guard';

/** TICKET-010 — create customer. */
export default function NewCustomerPage() {
  const denied = usePermissionGuard('customer:write');
  const router = useRouter();
  const queryClient = useQueryClient();

  // Checked before every other early return: a denied user should see the
  // denial immediately, not a loading skeleton or a form they cannot submit.
  // Placed after the hooks above so hook order stays stable across renders.
  if (denied) return denied;

  async function handleSubmit(values: CustomerFormValues) {
    const customer = await createCustomer(values);
    // Invalidate so the list reflects the new row immediately (Spec §32).
    await queryClient.invalidateQueries({ queryKey: ['customers'] });
    router.push(`/customers/${customer.id}`);
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <Link
          href="/customers"
          className="inline-flex items-center gap-1 text-body-sm text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Customers
        </Link>
        <h1 className="mt-2 text-h1 text-ink">New customer</h1>
      </div>

      <CustomerForm
        initialValues={emptyCustomerForm()}
        submitLabel="Create customer"
        onSubmit={handleSubmit}
        onCancel={() => router.push('/customers')}
      />
    </div>
  );
}
