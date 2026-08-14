'use client';

import { useState } from 'react';
import { ApiRequestError } from '../../lib/api-client';
import type { Customer, CustomerFormValues } from '../../lib/customers';
import { Button, Card, Field, Input, Textarea, Select } from '../ui/primitives';

/**
 * Shared create/edit form (TICKET-010, TICKET-011).
 *
 * Client-side validation is for fast feedback only; the API re-validates
 * everything and its field-level errors are surfaced here when returned
 * (Frontend Spec §37).
 */

const EMPTY_ADDRESS = {
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  countryCode: 'IN',
};

export function emptyCustomerForm(): CustomerFormValues {
  return {
    customerType: 'COMPANY',
    companyName: '',
    contactName: '',
    email: '',
    phone: '',
    taxNumber: '',
    billing: { ...EMPTY_ADDRESS },
    shippingSameAsBilling: true,
    shipping: { ...EMPTY_ADDRESS },
    notes: '',
  };
}

export function customerToForm(customer: Customer): CustomerFormValues {
  const shippingMatchesBilling =
    customer.shippingAddressLine1 === customer.billingAddressLine1 &&
    customer.shippingCity === customer.billingCity &&
    customer.shippingPostalCode === customer.billingPostalCode;

  return {
    customerType: customer.customerType,
    companyName: customer.companyName ?? '',
    contactName: customer.contactName ?? '',
    email: customer.email ?? '',
    phone: customer.phone ?? '',
    taxNumber: customer.taxNumber ?? '',
    billing: {
      addressLine1: customer.billingAddressLine1 ?? '',
      addressLine2: customer.billingAddressLine2 ?? '',
      city: customer.billingCity ?? '',
      state: customer.billingState ?? '',
      postalCode: customer.billingPostalCode ?? '',
      countryCode: customer.billingCountryCode ?? 'IN',
    },
    shippingSameAsBilling: shippingMatchesBilling,
    shipping: {
      addressLine1: customer.shippingAddressLine1 ?? '',
      addressLine2: customer.shippingAddressLine2 ?? '',
      city: customer.shippingCity ?? '',
      state: customer.shippingState ?? '',
      postalCode: customer.shippingPostalCode ?? '',
      countryCode: customer.shippingCountryCode ?? 'IN',
    },
    notes: customer.notes ?? '',
  };
}

const COUNTRIES = [
  ['IN', 'India'],
  ['GB', 'United Kingdom'],
  ['US', 'United States'],
  ['AE', 'United Arab Emirates'],
  ['SG', 'Singapore'],
] as const;

export function CustomerForm({
  initialValues,
  submitLabel,
  onSubmit,
  onCancel,
  /** Locked on edit: changing type would invalidate documents already issued. */
  lockType = false,
}: {
  initialValues: CustomerFormValues;
  submitLabel: string;
  onSubmit: (values: CustomerFormValues) => Promise<void>;
  onCancel: () => void;
  lockType?: boolean;
}) {
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function set<K extends keyof CustomerFormValues>(key: K, value: CustomerFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function setAddress(kind: 'billing' | 'shipping', field: string, value: string) {
    setValues((prev) => ({ ...prev, [kind]: { ...prev[kind], [field]: value } }));
  }

  function validate(): boolean {
    const next: Record<string, string> = {};

    if (values.customerType === 'COMPANY' && !values.companyName.trim()) {
      next.companyName = 'Company name is required';
    }
    if (values.customerType === 'INDIVIDUAL' && !values.contactName.trim()) {
      next.contactName = 'Contact name is required';
    }
    if (values.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email.trim())) {
      next.email = 'Enter a valid email address';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return; // Guard against duplicate submission (Spec §8).
    if (!validate()) return;

    setSubmitting(true);
    setFormError(null);

    try {
      await onSubmit(values);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        if (error.details?.length) {
          // Server field errors take precedence over local ones.
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
        <h2 className="text-h4 text-ink">Details</h2>

        <Field label="Customer type" htmlFor="customerType" required>
          <Select
            id="customerType"
            value={values.customerType}
            disabled={lockType}
            onChange={(e) => set('customerType', e.target.value as 'INDIVIDUAL' | 'COMPANY')}
          >
            <option value="COMPANY">Company</option>
            <option value="INDIVIDUAL">Individual</option>
          </Select>
        </Field>
        {lockType && (
          <p className="-mt-2 text-caption text-ink-muted">
            Customer type cannot be changed after creation.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Company name"
            htmlFor="companyName"
            error={errors.companyName}
            required={values.customerType === 'COMPANY'}
          >
            <Input
              id="companyName"
              value={values.companyName}
              invalid={Boolean(errors.companyName)}
              onChange={(e) => set('companyName', e.target.value)}
            />
          </Field>

          <Field
            label="Contact name"
            htmlFor="contactName"
            error={errors.contactName}
            required={values.customerType === 'INDIVIDUAL'}
          >
            <Input
              id="contactName"
              value={values.contactName}
              invalid={Boolean(errors.contactName)}
              onChange={(e) => set('contactName', e.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" htmlFor="email" error={errors.email}>
            <Input
              id="email"
              type="email"
              value={values.email}
              invalid={Boolean(errors.email)}
              onChange={(e) => set('email', e.target.value)}
            />
          </Field>
          <Field label="Phone" htmlFor="phone" error={errors.phone}>
            <Input id="phone" value={values.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
        </div>

        <Field label="Tax / GST number" htmlFor="taxNumber" error={errors.taxNumber}>
          <Input
            id="taxNumber"
            value={values.taxNumber}
            onChange={(e) => set('taxNumber', e.target.value)}
          />
        </Field>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-h4 text-ink">Billing address</h2>
        <AddressFields kind="billing" values={values.billing} onChange={setAddress} />
      </Card>

      <Card className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-h4 text-ink">Service / shipping address</h2>
          <label className="flex items-center gap-2 text-body-sm text-ink-secondary">
            <input
              type="checkbox"
              checked={values.shippingSameAsBilling}
              onChange={(e) => set('shippingSameAsBilling', e.target.checked)}
              className="h-4 w-4 rounded border-border-strong text-primary focus:ring-2 focus:ring-primary-light"
            />
            Same as billing
          </label>
        </div>

        {values.shippingSameAsBilling ? (
          <p className="text-body-sm text-ink-muted">
            The billing address will be used for shipping.
          </p>
        ) : (
          <AddressFields kind="shipping" values={values.shipping} onChange={setAddress} />
        )}
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-h4 text-ink">Notes</h2>
        <Field label="Internal notes" htmlFor="notes" hint="Not shown to the customer.">
          <Textarea
            id="notes"
            rows={4}
            value={values.notes}
            onChange={(e) => set('notes', e.target.value)}
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

function AddressFields({
  kind,
  values,
  onChange,
}: {
  kind: 'billing' | 'shipping';
  values: CustomerFormValues['billing'];
  onChange: (kind: 'billing' | 'shipping', field: string, value: string) => void;
}) {
  return (
    <>
      <Field label="Address line 1" htmlFor={`${kind}-line1`}>
        <Input
          id={`${kind}-line1`}
          value={values.addressLine1}
          onChange={(e) => onChange(kind, 'addressLine1', e.target.value)}
        />
      </Field>
      <Field label="Address line 2" htmlFor={`${kind}-line2`}>
        <Input
          id={`${kind}-line2`}
          value={values.addressLine2}
          onChange={(e) => onChange(kind, 'addressLine2', e.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="City" htmlFor={`${kind}-city`}>
          <Input
            id={`${kind}-city`}
            value={values.city}
            onChange={(e) => onChange(kind, 'city', e.target.value)}
          />
        </Field>
        <Field label="State" htmlFor={`${kind}-state`}>
          <Input
            id={`${kind}-state`}
            value={values.state}
            onChange={(e) => onChange(kind, 'state', e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Postal code" htmlFor={`${kind}-postal`}>
          <Input
            id={`${kind}-postal`}
            value={values.postalCode}
            onChange={(e) => onChange(kind, 'postalCode', e.target.value)}
          />
        </Field>
        <Field label="Country" htmlFor={`${kind}-country`}>
          <Select
            id={`${kind}-country`}
            value={values.countryCode}
            onChange={(e) => onChange(kind, 'countryCode', e.target.value)}
          >
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </>
  );
}
