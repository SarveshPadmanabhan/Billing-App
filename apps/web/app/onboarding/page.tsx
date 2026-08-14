'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiRequestError } from '../../lib/api-client';

/**
 * Organisation onboarding (TICKET-005).
 * The creator becomes OWNER — decided and enforced server-side.
 */
export default function OnboardingPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    legalName: '',
    email: '',
    phone: '',
    taxNumber: '',
    city: '',
    countryCode: 'IN',
    currencyCode: 'INR',
    invoicePrefix: 'INV-',
    quotationPrefix: 'QUO-',
    defaultPaymentTermsDays: '30',
    defaultTaxRate: '18',
  });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  function update(field: keyof typeof form) {
    return (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((prev) => ({ ...prev, [field]: event.target.value }));
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);
    setFieldErrors({});

    try {
      await apiFetch('/organisations', {
        method: 'POST',
        json: {
          name: form.name,
          legalName: form.legalName || null,
          email: form.email || null,
          phone: form.phone || null,
          taxNumber: form.taxNumber || null,
          city: form.city || null,
          countryCode: form.countryCode,
          currencyCode: form.currencyCode,
          invoicePrefix: form.invoicePrefix,
          quotationPrefix: form.quotationPrefix,
          defaultPaymentTermsDays: Number(form.defaultPaymentTermsDays),
          defaultTaxRate: form.defaultTaxRate,
        },
      });

      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        if (err.details?.length) {
          setFieldErrors(Object.fromEntries(err.details.map((d) => [d.field, d.message])));
        }
        setError(err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
      setSubmitting(false);
    }
  }

  const inputClass =
    'h-10 rounded-sm border border-border-strong px-3 text-body outline-none focus:border-primary focus:ring-2 focus:ring-primary-light';

  return (
    <main className="flex min-h-screen items-start justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-[640px] rounded-md border border-border bg-surface p-6 shadow-card">
        <h1 className="text-h2 text-ink">Set up your organisation</h1>
        <p className="mt-1 text-body text-ink-muted">
          You&apos;ll be the owner. These details appear on your invoices and quotations.
        </p>

        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-5" noValidate>
          {error && (
            <div role="alert" className="rounded-sm bg-danger-light p-3 text-body-sm text-danger">
              {error}
            </div>
          )}

          <section className="flex flex-col gap-4">
            <h2 className="text-h4 text-ink">Profile</h2>

            <div className="flex flex-col gap-2">
              <label htmlFor="name" className="text-body-sm font-medium text-ink">
                Organisation name <span className="text-danger">*</span>
              </label>
              <input id="name" required value={form.name} onChange={update('name')} className={inputClass} />
              {fieldErrors.name && <p className="text-caption text-danger">{fieldErrors.name}</p>}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <label htmlFor="legalName" className="text-body-sm font-medium text-ink">
                  Legal name
                </label>
                <input id="legalName" value={form.legalName} onChange={update('legalName')} className={inputClass} />
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="taxNumber" className="text-body-sm font-medium text-ink">
                  Tax / GST number
                </label>
                <input id="taxNumber" value={form.taxNumber} onChange={update('taxNumber')} className={inputClass} />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <label htmlFor="email" className="text-body-sm font-medium text-ink">
                  Billing email
                </label>
                <input id="email" type="email" value={form.email} onChange={update('email')} className={inputClass} />
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="phone" className="text-body-sm font-medium text-ink">
                  Phone
                </label>
                <input id="phone" value={form.phone} onChange={update('phone')} className={inputClass} />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="flex flex-col gap-2">
                <label htmlFor="city" className="text-body-sm font-medium text-ink">
                  City
                </label>
                <input id="city" value={form.city} onChange={update('city')} className={inputClass} />
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="countryCode" className="text-body-sm font-medium text-ink">
                  Country
                </label>
                <select id="countryCode" value={form.countryCode} onChange={update('countryCode')} className={inputClass}>
                  <option value="IN">India</option>
                  <option value="GB">United Kingdom</option>
                  <option value="US">United States</option>
                  <option value="AE">UAE</option>
                  <option value="SG">Singapore</option>
                </select>
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="currencyCode" className="text-body-sm font-medium text-ink">
                  Currency
                </label>
                <select id="currencyCode" value={form.currencyCode} onChange={update('currencyCode')} className={inputClass}>
                  <option value="INR">INR</option>
                  <option value="GBP">GBP</option>
                  <option value="USD">USD</option>
                  <option value="AED">AED</option>
                  <option value="SGD">SGD</option>
                </select>
                <p className="text-caption text-ink-muted">Cannot be changed later.</p>
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-4 border-t border-border pt-5">
            <h2 className="text-h4 text-ink">Document defaults</h2>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <label htmlFor="invoicePrefix" className="text-body-sm font-medium text-ink">
                  Invoice prefix
                </label>
                <input id="invoicePrefix" value={form.invoicePrefix} onChange={update('invoicePrefix')} className={inputClass} />
                <p className="text-caption text-ink-muted">e.g. {form.invoicePrefix}000001</p>
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="quotationPrefix" className="text-body-sm font-medium text-ink">
                  Quotation prefix
                </label>
                <input id="quotationPrefix" value={form.quotationPrefix} onChange={update('quotationPrefix')} className={inputClass} />
                <p className="text-caption text-ink-muted">e.g. {form.quotationPrefix}000001</p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <label htmlFor="defaultPaymentTermsDays" className="text-body-sm font-medium text-ink">
                  Payment terms (days)
                </label>
                <input
                  id="defaultPaymentTermsDays"
                  type="number"
                  min={0}
                  max={365}
                  value={form.defaultPaymentTermsDays}
                  onChange={update('defaultPaymentTermsDays')}
                  className={`${inputClass} tabular`}
                />
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="defaultTaxRate" className="text-body-sm font-medium text-ink">
                  Default tax rate (%)
                </label>
                <input
                  id="defaultTaxRate"
                  value={form.defaultTaxRate}
                  onChange={update('defaultTaxRate')}
                  className={`${inputClass} tabular`}
                />
              </div>
            </div>
          </section>

          <button
            type="submit"
            disabled={submitting}
            className="h-10 self-start rounded-sm bg-primary px-6 text-body font-medium text-white transition-colors hover:bg-primary-hover disabled:bg-ink-disabled"
          >
            {submitting ? 'Creating…' : 'Create organisation'}
          </button>
        </form>
      </div>
    </main>
  );
}
