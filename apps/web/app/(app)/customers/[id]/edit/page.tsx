'use client';

import { useRouter, useParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import {
  getCustomer,
  updateCustomer,
  customerName,
  type CustomerFormValues,
} from '../../../../../lib/customers';
import { CustomerForm, customerToForm } from '../../../../../components/customers/customer-form';
import { ErrorState, TableSkeleton, Card } from '../../../../../components/ui/primitives';
import { ApiRequestError } from '../../../../../lib/api-client';

/** TICKET-011 — edit customer. */
export default function EditCustomerPage() {
  const router = useRouter();
  const params = useParams();
  const queryClient = useQueryClient();
  const id = String(params?.id ?? '');

  const { data: customer, isLoading, error, refetch } = useQuery({
    queryKey: ['customers', id],
    queryFn: () => getCustomer(id),
    enabled: Boolean(id),
  });

  async function handleSubmit(values: CustomerFormValues) {
    // Pass the timestamp the form was loaded with so a concurrent edit by
    // someone else is rejected rather than silently overwritten (§24).
    await updateCustomer(id, values, customer?.updatedAt);
    await queryClient.invalidateQueries({ queryKey: ['customers'] });
    router.push(`/customers/${id}`);
  }

  if (isLoading) return <TableSkeleton rows={6} columns={2} />;

  if (error) {
    const notFound = error instanceof ApiRequestError && error.status === 404;
    return (
      <ErrorState
        message={notFound ? 'This customer could not be found.' : 'We could not load this customer.'}
        onRetry={notFound ? undefined : () => refetch()}
      />
    );
  }

  if (!customer) return null;

  if (customer.isArchived) {
    return (
      <Card>
        <h1 className="text-h3 text-ink">This customer is archived</h1>
        <p className="mt-2 text-body text-ink-muted">
          Archived customers cannot be edited. Restore the customer first to make changes.
        </p>
        <Link href={`/customers/${id}`} className="mt-4 inline-block text-body text-primary hover:underline">
          Back to customer
        </Link>
      </Card>
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <Link
          href={`/customers/${id}`}
          className="inline-flex items-center gap-1 text-body-sm text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          {customerName(customer)}
        </Link>
        <h1 className="mt-2 text-h1 text-ink">Edit customer</h1>
      </div>

      <CustomerForm
        initialValues={customerToForm(customer)}
        submitLabel="Save changes"
        onSubmit={handleSubmit}
        onCancel={() => router.push(`/customers/${id}`)}
        lockType
      />
    </div>
  );
}
