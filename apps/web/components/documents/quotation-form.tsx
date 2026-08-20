'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiRequestError } from '../../lib/api-client';
import { listCustomers } from '../../lib/customers';
import { CustomerPicker } from './customer-picker';
import type { QuotationFormValues } from '../../lib/quotations';
import { Button, Card, Field, Input, Textarea, Select } from '../ui/primitives';
import { LineItemsEditor, TotalsSummary } from './line-items-editor';

/**
 * Quotation create/edit form (TICKET-016, TICKET-018).
 *
 * Client-side checks give fast feedback; the API re-validates everything and
 * its field errors replace the local ones when returned.
 */
export function QuotationForm({
  initialValues,
  currency,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialValues: QuotationFormValues;
  currency: string;
  submitLabel: string;
  onSubmit: (values: QuotationFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Only active customers can be selected: an archived customer cannot receive
  // new documents, and the API rejects it anyway.
  const { data: customers, isLoading: customersLoading } = useQuery({
    queryKey: ['customers', { status: 'active', limit: 100 }],
    queryFn: () => listCustomers({ status: 'active', limit: 100, sort: 'companyName', direction: 'asc' }),
  });

  function set<K extends keyof QuotationFormValues>(key: K, value: QuotationFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): boolean {
    const next: Record<string, string> = {};

    if (!values.customerId) next.customerId = 'Select a customer';
    if (!values.issueDate) next.issueDate = 'Quotation date is required';
    if (values.validUntil && values.validUntil < values.issueDate) {
      next.validUntil = 'Valid-until date must be on or after the quotation date';
    }

    values.items.forEach((item, index) => {
      if (!item.description.trim()) {
        next[`items[${index}].description`] = 'Required';
      }
      if (!item.quantity || Number(item.quantity) <= 0) {
        next[`items[${index}].quantity`] = 'Must be > 0';
      }
      if (item.unitPrice === '' || Number(item.unitPrice) < 0) {
        next[`items[${index}].unitPrice`] = 'Required';
      }
      if (item.discountRate && Number(item.discountRate) > 100) {
        next[`items[${index}].discountRate`] = 'Max 100';
      }
      if (item.taxRate && Number(item.taxRate) > 100) {
        next[`items[${index}].taxRate`] = 'Max 100';
      }
    });

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (!validate()) return;

    setSubmitting(true);
    setFormError(null);

    try {
      await onSubmit(values);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        if (error.details?.length) {
          setErrors(Object.fromEntries(error.details.map((d) => [d.field, d.message])));
        }
        setFormError(error.message);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
      {formError && (
        <div role="alert" className="rounded-sm bg-danger-light p-3 text-body-sm text-danger">
          {formError}
        </div>
      )}

      <Card className="flex flex-col gap-4">
        <h2 className="text-h4 text-ink">Customer and dates</h2>

        <Field label="Customer" htmlFor="customerId" error={errors.customerId} required>
          <CustomerPicker
            id="customerId"
            customers={customers?.items ?? []}
            loading={customersLoading}
            value={values.customerId}
            invalid={Boolean(errors.customerId)}
            onChange={(customerId) => set('customerId', customerId)}
          />
        </Field>

        {customers && customers.items.length === 0 && (
          <p className="text-caption text-warning">
            You have no active customers. Add one before creating a quotation.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Quotation date" htmlFor="issueDate" error={errors.issueDate} required>
            <Input
              id="issueDate"
              type="date"
              value={values.issueDate}
              invalid={Boolean(errors.issueDate)}
              onChange={(e) => set('issueDate', e.target.value)}
            />
          </Field>
          <Field
            label="Valid until"
            htmlFor="validUntil"
            error={errors.validUntil}
            hint="The offer expires after this date."
          >
            <Input
              id="validUntil"
              type="date"
              value={values.validUntil}
              invalid={Boolean(errors.validUntil)}
              onChange={(e) => set('validUntil', e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-h4 text-ink">Items</h2>
        <LineItemsEditor
          items={values.items}
          onChange={(items) => set('items', items)}
          currency={currency}
          errors={errors}
          disabled={submitting}
        />
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-h4 text-ink">Discount and totals</h2>
        <div className="max-w-[220px]">
          <Field
            label="Overall discount (%)"
            htmlFor="discountRate"
            error={errors['discount.rate']}
            hint="Applied to the subtotal."
          >
            <Input
              id="discountRate"
              inputMode="decimal"
              className="tabular text-right"
              value={values.discountRate}
              onChange={(e) => set('discountRate', e.target.value)}
              placeholder="0"
            />
          </Field>
        </div>
        <TotalsSummary
          items={values.items}
          documentDiscountRate={values.discountRate}
          currency={currency}
        />
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-h4 text-ink">Notes and terms</h2>
        <Field label="Notes" htmlFor="notes" hint="Shown on the quotation PDF.">
          <Textarea
            id="notes"
            rows={3}
            value={values.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </Field>
        <Field label="Terms" htmlFor="terms" hint="Shown on the quotation PDF.">
          <Textarea
            id="terms"
            rows={3}
            value={values.terms}
            onChange={(e) => set('terms', e.target.value)}
          />
        </Field>
      </Card>

      <div className="flex gap-3">
        <Button type="submit" loading={submitting}>
          {submitLabel}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
