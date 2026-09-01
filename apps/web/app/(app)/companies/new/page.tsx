'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { apiFetch, ApiRequestError } from '../../../../lib/api-client';
import { usePermissionGuard } from '../../../../lib/use-permission-guard';
import { Button, Card, Field, Input, Select } from '../../../../components/ui/primitives';

/** Add a company to the current organisation. */

const COUNTRIES = [
  ['IN', 'India'],
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
  ['AE', 'United Arab Emirates'],
  ['SG', 'Singapore'],
  ['AU', 'Australia'],
] as const;

interface CompanyForm {
  name: string;
  legalName: string;
  taxNumber: string;
  upiId: string;
  email: string;
  phone: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
  invoicePrefix: string;
  quotationPrefix: string;
}

const EMPTY: CompanyForm = {
  name: '',
  legalName: '',
  taxNumber: '',
  upiId: '',
  email: '',
  phone: '',
  addressLine1: '',
  city: '',
  state: '',
  postalCode: '',
  countryCode: 'IN',
  invoicePrefix: 'INV-',
  quotationPrefix: 'QUO-',
};

export default function NewCompanyPage() {
  const denied = usePermissionGuard('organisation:settings');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<CompanyForm>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (denied) return denied;

  function set<K extends keyof CompanyForm>(key: K, value: CompanyForm[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  /**
   * Validate one prefix. Mirrors the server rule.
   *
   * A prefix ending in a digit runs straight into the zero-padded number:
   * "QUO-1" + "000001" reads as QUO-1000001, which could equally be prefix
   * "QUO-" with number 1000001. The document number stops being parseable
   * back into its parts, so the trailing digit is rejected.
   */
  function prefixError(label: string, value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) return `${label} prefix is required`;
    if (/[0-9]$/.test(trimmed)) {
      return `Prefix cannot end in a digit — "${trimmed}" would produce ${trimmed}000001, which is ambiguous. Try "${trimmed.replace(/[0-9]+$/, '')}".`;
    }
    return undefined;
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!values.name.trim()) next.name = 'Company name is required';

    // Money goes to whatever this resolves to, so a typo here is a real
    // financial error. Shape is all that can be checked locally.
    if (values.upiId.trim() && !/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/.test(values.upiId.trim())) {
      next.upiId = 'Enter a UPI ID like name@bank';
    }

    const invoice = prefixError('Invoice', values.invoicePrefix);
    if (invoice) next.invoicePrefix = invoice;
    const quotation = prefixError('Quotation', values.quotationPrefix);
    if (quotation) next.quotationPrefix = quotation;

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  /**
   * Clear a field's error as soon as the user edits it.
   *
   * Without this an error set on a previous submit outlives the value that
   * caused it: emptying a rejected prefix left "must not end in a digit"
   * sitting under a blank box, describing input that was no longer there.
   */
  function setField<K extends keyof CompanyForm>(key: K, value: CompanyForm[K]) {
    set(key, value);
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setFormError(null);
    if (!validate()) return;

    setSubmitting(true);
    try {
      const company = await apiFetch<{ id: string }>('/companies', {
        method: 'POST',
        json: {
          name: values.name,
          legalName: values.legalName || null,
          taxNumber: values.taxNumber || null,
          upiId: values.upiId.trim() || null,
          email: values.email || null,
          phone: values.phone || null,
          addressLine1: values.addressLine1 || null,
          city: values.city || null,
          state: values.state || null,
          postalCode: values.postalCode || null,
          countryCode: values.countryCode,
          invoicePrefix: values.invoicePrefix,
          quotationPrefix: values.quotationPrefix,
        },
      });

      // Switch straight into the new company: creating one and then still
      // looking at the previous company's data would be confusing.
      await apiFetch('/companies/switch', { method: 'POST', json: { companyId: company.id } });

      await queryClient.invalidateQueries();
      router.push('/dashboard');
      router.refresh();
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
          href="/dashboard"
          className="inline-flex items-center gap-1 text-body-sm text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Dashboard
        </Link>
        <h1 className="mt-2 text-h1 text-ink">Add a company</h1>
        <p className="mt-1 text-body text-ink-muted">
          A separate legal entity in this organisation, with its own invoice numbering, customers
          and financial position.
        </p>
      </div>

      {formError && (
        <div role="alert" className="rounded-md bg-danger-light p-4 text-body text-danger">
          {formError}
        </div>
      )}

      <Card className="flex flex-col gap-4">
        <h2 className="text-h4 text-ink">Profile</h2>

        <Field label="Company name" htmlFor="name" required error={errors.name}>
          <Input
            id="name"
            value={values.name}
            invalid={Boolean(errors.name)}
            onChange={(e) => setField('name', e.target.value)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Legal name" htmlFor="legalName" error={errors.legalName}>
            <Input
              id="legalName"
              value={values.legalName}
              onChange={(e) => setField('legalName', e.target.value)}
            />
          </Field>
          <Field label="Tax / GST number" htmlFor="taxNumber" error={errors.taxNumber}>
            <Input
              id="taxNumber"
              value={values.taxNumber}
              onChange={(e) => setField('taxNumber', e.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="UPI ID"
            htmlFor="upiId"
            error={errors.upiId}
            hint="Prints a scannable payment QR on this company's invoices."
          >
            <Input
              id="upiId"
              value={values.upiId}
              invalid={Boolean(errors.upiId)}
              placeholder="name@bank"
              onChange={(e) => setField('upiId', e.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Billing email" htmlFor="email" error={errors.email}>
            <Input
              id="email"
              type="email"
              value={values.email}
              invalid={Boolean(errors.email)}
              onChange={(e) => setField('email', e.target.value)}
            />
          </Field>
          <Field label="Phone" htmlFor="phone" error={errors.phone}>
            <Input id="phone" value={values.phone} onChange={(e) => setField('phone', e.target.value)} />
          </Field>
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-h4 text-ink">Address</h2>
        <Field label="Address line 1" htmlFor="addressLine1" error={errors.addressLine1}>
          <Input
            id="addressLine1"
            value={values.addressLine1}
            onChange={(e) => setField('addressLine1', e.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="City" htmlFor="city" error={errors.city}>
            <Input id="city" value={values.city} onChange={(e) => setField('city', e.target.value)} />
          </Field>
          <Field label="State" htmlFor="state" error={errors.state}>
            <Input id="state" value={values.state} onChange={(e) => setField('state', e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Postal code" htmlFor="postalCode" error={errors.postalCode}>
            <Input
              id="postalCode"
              value={values.postalCode}
              onChange={(e) => setField('postalCode', e.target.value)}
            />
          </Field>
          <Field label="Country" htmlFor="countryCode">
            <Select
              id="countryCode"
              value={values.countryCode}
              onChange={(e) => setField('countryCode', e.target.value)}
            >
              {COUNTRIES.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-h4 text-ink">Document numbering</h2>
        <p className="text-body-sm text-ink-muted">
          Each company numbers its own documents from 1. Give this company distinct prefixes so its
          invoices are tellable apart from the others. These cannot be changed later.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Invoice prefix"
            htmlFor="invoicePrefix"
            required
            error={errors.invoicePrefix}
            hint="e.g. ABC- produces ABC-000001"
          >
            <Input
              id="invoicePrefix"
              value={values.invoicePrefix}
              invalid={Boolean(errors.invoicePrefix)}
              onChange={(e) => setField('invoicePrefix', e.target.value)}
            />
          </Field>
          <Field
            label="Quotation prefix"
            htmlFor="quotationPrefix"
            required
            error={errors.quotationPrefix}
          >
            <Input
              id="quotationPrefix"
              value={values.quotationPrefix}
              invalid={Boolean(errors.quotationPrefix)}
              onChange={(e) => setField('quotationPrefix', e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <div className="flex gap-3">
        <Button type="submit" loading={submitting}>
          Create company
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.push('/dashboard')}
          disabled={submitting}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
