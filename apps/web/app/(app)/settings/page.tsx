'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Check, Pencil } from 'lucide-react';
import type { CurrentUserResponse } from '@billing/types';
import { hasPermission } from '@billing/types';
import { apiFetch, ApiRequestError } from '../../../lib/api-client';
import {
  Button,
  Card,
  Badge,
  Field,
  Input,
  Select,
  EmptyState,
  ErrorState,
  PermissionDenied,
  TableSkeleton,
} from '../../../components/ui/primitives';

/** Settings: company details. The organisation profile is a later addition. */

interface Company {
  id: string;
  name: string;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  countryCode: string;
  taxNumber: string | null;
  upiId: string | null;
  invoicePrefix: string;
  quotationPrefix: string;
  isDefault: boolean;
}

const COUNTRIES = [
  ['IN', 'India'],
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
  ['AE', 'United Arab Emirates'],
  ['SG', 'Singapore'],
  ['AU', 'Australia'],
] as const;

const UPI_PATTERN = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/;

export default function SettingsPage() {
  const [editing, setEditing] = useState<string | null>(null);

  const { data: me } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<CurrentUserResponse>('/auth/me'),
  });

  const companies = useQuery({
    queryKey: ['companies'],
    queryFn: () => apiFetch<Company[]>('/companies'),
  });

  const role = me?.organisation?.role;
  const canView = role ? hasPermission(role, 'dashboard:view') : true;
  const canEdit = role ? hasPermission(role, 'organisation:settings') : false;

  if (role && !canView) return <PermissionDenied />;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-h1 text-ink">Settings</h1>
          <p className="mt-1 text-body text-ink-muted">
            Companies in {me?.organisation?.organisationName ?? 'this organisation'}. These details
            appear on the invoices and quotations each company issues.
          </p>
        </div>
        {canEdit && (
          <Link href="/companies/new">
            <Button>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add company
            </Button>
          </Link>
        )}
      </header>

      {companies.isLoading ? (
        <TableSkeleton rows={3} columns={4} />
      ) : companies.error ? (
        <ErrorState
          message={
            companies.error instanceof ApiRequestError
              ? companies.error.message
              : 'We could not load your companies.'
          }
          onRetry={() => companies.refetch()}
        />
      ) : !companies.data || companies.data.length === 0 ? (
        <EmptyState
          title="No companies yet"
          description="Every organisation has at least one company. If you are seeing this, something is wrong."
        />
      ) : (
        companies.data.map((company) =>
          editing === company.id ? (
            <CompanyForm
              key={company.id}
              company={company}
              onCancel={() => setEditing(null)}
              onSaved={() => setEditing(null)}
            />
          ) : (
            <CompanySummary
              key={company.id}
              company={company}
              canEdit={canEdit}
              onEdit={() => setEditing(company.id)}
            />
          ),
        )
      )}
    </div>
  );
}

function CompanySummary({
  company,
  canEdit,
  onEdit,
}: {
  company: Company;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const address = [
    company.addressLine1,
    company.addressLine2,
    company.city,
    company.state,
    company.postalCode,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-h4 text-ink">{company.name}</h2>
            {company.isDefault && <Badge tone="blue">Default</Badge>}
          </div>
          {company.legalName && (
            <p className="mt-1 text-body-sm text-ink-muted">{company.legalName}</p>
          )}
        </div>
        {canEdit && (
          <Button variant="secondary" onClick={onEdit}>
            <Pencil className="h-4 w-4" aria-hidden="true" />
            Edit
          </Button>
        )}
      </div>

      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Detail label="Address" value={address} missing="Falls back to the organisation's address" />
        <Detail
          label="Tax / GST number"
          value={company.taxNumber}
          missing="Falls back to the organisation's"
        />
        <Detail
          label="UPI ID"
          value={company.upiId}
          missing="No payment QR on invoices"
          mono
        />
        <Detail label="Email" value={company.email} />
        <Detail label="Phone" value={company.phone} />
        <Detail
          label="Numbering"
          value={`${company.invoicePrefix}… / ${company.quotationPrefix}…`}
        />
      </dl>
    </Card>
  );
}

/**
 * One field. A missing value says what the consequence is rather than showing
 * a dash — "no address" is invisible until an invoice goes out with the wrong
 * entity's details on it.
 */
function Detail({
  label,
  value,
  missing,
  mono = false,
}: {
  label: string;
  value: string | null;
  missing?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-caption text-ink-muted">{label}</dt>
      <dd className={`text-body ${value ? 'text-ink' : 'text-warning'} ${mono && value ? 'tabular' : ''}`}>
        {value || missing || '—'}
      </dd>
    </div>
  );
}

function CompanyForm({
  company,
  onCancel,
  onSaved,
}: {
  company: Company;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState({
    name: company.name,
    legalName: company.legalName ?? '',
    email: company.email ?? '',
    phone: company.phone ?? '',
    addressLine1: company.addressLine1 ?? '',
    addressLine2: company.addressLine2 ?? '',
    city: company.city ?? '',
    state: company.state ?? '',
    postalCode: company.postalCode ?? '',
    countryCode: company.countryCode,
    taxNumber: company.taxNumber ?? '',
    upiId: company.upiId ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function setField(key: keyof typeof values, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    if (!values.name.trim()) next.name = 'Company name is required';
    // Money goes wherever this resolves, so a typo is a financial error.
    // Shape is all that can be checked here.
    if (values.upiId.trim() && !UPI_PATTERN.test(values.upiId.trim())) {
      next.upiId = 'Enter a UPI ID like name@bank';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setFormError(null);
    if (!validate()) return;

    setSaving(true);
    try {
      await apiFetch(`/companies/${company.id}`, {
        method: 'PATCH',
        json: {
          name: values.name.trim(),
          legalName: values.legalName.trim() || null,
          email: values.email.trim() || null,
          phone: values.phone.trim() || null,
          addressLine1: values.addressLine1.trim() || null,
          addressLine2: values.addressLine2.trim() || null,
          city: values.city.trim() || null,
          state: values.state.trim() || null,
          postalCode: values.postalCode.trim() || null,
          countryCode: values.countryCode,
          taxNumber: values.taxNumber.trim() || null,
          upiId: values.upiId.trim() || null,
        },
      });
      // The company name and UPI ID appear in the topbar and on documents, so
      // refresh everything rather than just this list.
      await queryClient.invalidateQueries();
      onSaved();
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
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4">
      <form onSubmit={save} className="flex flex-col gap-4" noValidate>
        <div className="flex items-center gap-2">
          <h2 className="text-h4 text-ink">Edit {company.name}</h2>
          {company.isDefault && <Badge tone="blue">Default</Badge>}
        </div>

        {formError && (
          <div role="alert" className="rounded-md bg-danger-light p-3 text-body-sm text-danger">
            {formError}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company name" htmlFor={`name-${company.id}`} required error={errors.name}>
            <Input
              id={`name-${company.id}`}
              value={values.name}
              invalid={Boolean(errors.name)}
              onChange={(e) => setField('name', e.target.value)}
            />
          </Field>
          <Field label="Legal name" htmlFor={`legal-${company.id}`} error={errors.legalName}>
            <Input
              id={`legal-${company.id}`}
              value={values.legalName}
              onChange={(e) => setField('legalName', e.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Tax / GST number"
            htmlFor={`tax-${company.id}`}
            error={errors.taxNumber}
            hint="Printed on this company's invoices."
          >
            <Input
              id={`tax-${company.id}`}
              value={values.taxNumber}
              onChange={(e) => setField('taxNumber', e.target.value)}
            />
          </Field>
          <Field
            label="UPI ID"
            htmlFor={`upi-${company.id}`}
            error={errors.upiId}
            hint="Prints a scannable payment QR on invoices."
          >
            <Input
              id={`upi-${company.id}`}
              value={values.upiId}
              invalid={Boolean(errors.upiId)}
              placeholder="name@bank"
              onChange={(e) => setField('upiId', e.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" htmlFor={`email-${company.id}`} error={errors.email}>
            <Input
              id={`email-${company.id}`}
              type="email"
              value={values.email}
              invalid={Boolean(errors.email)}
              onChange={(e) => setField('email', e.target.value)}
            />
          </Field>
          <Field label="Phone" htmlFor={`phone-${company.id}`} error={errors.phone}>
            <Input
              id={`phone-${company.id}`}
              value={values.phone}
              onChange={(e) => setField('phone', e.target.value)}
            />
          </Field>
        </div>

        <Field label="Address line 1" htmlFor={`addr1-${company.id}`} error={errors.addressLine1}>
          <Input
            id={`addr1-${company.id}`}
            value={values.addressLine1}
            onChange={(e) => setField('addressLine1', e.target.value)}
          />
        </Field>
        <Field label="Address line 2" htmlFor={`addr2-${company.id}`} error={errors.addressLine2}>
          <Input
            id={`addr2-${company.id}`}
            value={values.addressLine2}
            onChange={(e) => setField('addressLine2', e.target.value)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="City" htmlFor={`city-${company.id}`} error={errors.city}>
            <Input
              id={`city-${company.id}`}
              value={values.city}
              onChange={(e) => setField('city', e.target.value)}
            />
          </Field>
          <Field label="State" htmlFor={`state-${company.id}`} error={errors.state}>
            <Input
              id={`state-${company.id}`}
              value={values.state}
              onChange={(e) => setField('state', e.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Postal code" htmlFor={`postal-${company.id}`} error={errors.postalCode}>
            <Input
              id={`postal-${company.id}`}
              value={values.postalCode}
              onChange={(e) => setField('postalCode', e.target.value)}
            />
          </Field>
          <Field label="Country" htmlFor={`country-${company.id}`}>
            <Select
              id={`country-${company.id}`}
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

        <p className="text-caption text-ink-muted">
          Currency and numbering prefixes cannot be changed — documents already issued carry both,
          and altering them would make historical invoices inconsistent with the company that
          issued them.
        </p>

        <div className="flex gap-3">
          <Button type="submit" loading={saving}>
            <Check className="h-4 w-4" aria-hidden="true" />
            Save changes
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
