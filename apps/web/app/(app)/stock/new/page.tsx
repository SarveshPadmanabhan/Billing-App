'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { apiFetch, ApiRequestError } from '../../../../lib/api-client';
import { usePermissionGuard } from '../../../../lib/use-permission-guard';
import { Button, Card, Field, Input, Textarea } from '../../../../components/ui/primitives';

/** Create a stock item. */

interface ItemForm {
  sku: string;
  name: string;
  description: string;
  unit: string;
  unitPrice: string;
  openingQuantity: string;
  tracksStock: boolean;
}

const EMPTY: ItemForm = {
  sku: '',
  name: '',
  description: '',
  unit: 'unit',
  unitPrice: '0',
  openingQuantity: '0',
  tracksStock: true,
};

const DECIMAL = /^\d+(\.\d{1,4})?$/;

export default function NewStockItemPage() {
  const denied = usePermissionGuard('stock:write');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<ItemForm>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (denied) return denied;

  function setField<K extends keyof ItemForm>(key: K, value: ItemForm[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    // Clear this field's error as soon as it is edited, so a message from a
    // previous submit cannot outlive the value that caused it.
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!values.sku.trim()) next.sku = 'Category is required';
    if (!values.name.trim()) next.name = 'Name is required';
    for (const field of ['unitPrice', 'openingQuantity'] as const) {
      if (!DECIMAL.test(values[field].trim())) {
        next[field] = 'Enter a number with up to 4 decimal places';
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setFormError(null);
    if (!validate()) return;

    setSubmitting(true);
    try {
      await apiFetch('/stock', {
        method: 'POST',
        json: {
          sku: values.sku.trim(),
          name: values.name.trim(),
          description: values.description.trim() || null,
          unit: values.unit.trim() || 'unit',
          unitPrice: values.unitPrice.trim(),
          openingQuantity: values.openingQuantity.trim(),
          // Reorder level is no longer set here. The API defaults it to 0, and
          // items created before this still keep the value they were given —
          // which is what the low-stock highlighting reads.
          reorderLevel: '0',
          tracksStock: values.tracksStock,
        },
      });
      await queryClient.invalidateQueries({ queryKey: ['stock'] });
      router.push('/stock');
    } catch (error) {
      if (error instanceof ApiRequestError) {
        if (error.details?.length) {
          setErrors(Object.fromEntries(error.details.map((d) => [d.field, d.message])));
        }
        setFormError(error.message);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-3xl flex-col gap-6" noValidate>
      <div>
        <Link
          href="/stock"
          className="inline-flex items-center gap-1 text-body-sm text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Stock
        </Link>
        <h1 className="mt-2 text-h1 text-ink">New stock item</h1>
      </div>

      {formError && (
        <div role="alert" className="rounded-md bg-danger-light p-4 text-body text-danger">
          {formError}
        </div>
      )}

      <Card className="flex flex-col gap-4">
        <h2 className="text-h4 text-ink">Item</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Labelled "Category"; still stored as `sku`. */}
          <Field label="Category" htmlFor="sku" required error={errors.sku}>
            <Input
              id="sku"
              value={values.sku}
              invalid={Boolean(errors.sku)}
              onChange={(e) => setField('sku', e.target.value)}
            />
          </Field>
          <Field label="Unit" htmlFor="unit" hint="pcs, kg, hrs…" error={errors.unit}>
            <Input id="unit" value={values.unit} onChange={(e) => setField('unit', e.target.value)} />
          </Field>
        </div>

        <Field label="Name" htmlFor="name" required error={errors.name}>
          <Input
            id="name"
            value={values.name}
            invalid={Boolean(errors.name)}
            onChange={(e) => setField('name', e.target.value)}
          />
        </Field>

        <Field label="Description" htmlFor="description" error={errors.description}>
          <Textarea
            id="description"
            rows={3}
            value={values.description}
            onChange={(e) => setField('description', e.target.value)}
          />
        </Field>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-h4 text-ink">Quantity and price</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Unit price" htmlFor="unitPrice" error={errors.unitPrice}>
            <Input
              id="unitPrice"
              inputMode="decimal"
              className="tabular text-right"
              value={values.unitPrice}
              invalid={Boolean(errors.unitPrice)}
              onChange={(e) => setField('unitPrice', e.target.value)}
            />
          </Field>
          <Field
            label="Opening quantity"
            htmlFor="openingQuantity"
            error={errors.openingQuantity}
            hint="Recorded as a movement"
          >
            <Input
              id="openingQuantity"
              inputMode="decimal"
              className="tabular text-right"
              value={values.openingQuantity}
              invalid={Boolean(errors.openingQuantity)}
              onChange={(e) => setField('openingQuantity', e.target.value)}
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-body-sm text-ink-secondary">
          <input
            type="checkbox"
            checked={values.tracksStock}
            onChange={(e) => setField('tracksStock', e.target.checked)}
            className="h-4 w-4 rounded border-border-strong text-primary focus:ring-2 focus:ring-primary-light"
          />
          Deduct this item from stock when an invoice is issued
        </label>
        <p className="text-caption text-ink-muted">
          Leave unticked for services or goods bought to order — those are invoiced without a stock
          check.
        </p>
      </Card>

      <div className="flex gap-3">
        <Button type="submit" loading={submitting}>
          Create item
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.push('/stock')}
          disabled={submitting}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
