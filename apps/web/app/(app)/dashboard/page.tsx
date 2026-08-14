'use client';

import { useQuery } from '@tanstack/react-query';
import type { CurrentUserResponse } from '@billing/types';
import { apiFetch } from '../../../lib/api-client';

/**
 * Dashboard shell (TICKET-008).
 *
 * KPI cards are placeholders: the Technical Architecture Document §25 is
 * explicit that the dashboard must come last, because its numbers are only
 * meaningful once the invoice and payment models are correct. Wiring it to
 * real aggregates now would mean displaying figures with no ledger behind them.
 */
export default function DashboardPage() {
  const { data } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<CurrentUserResponse>('/auth/me'),
  });

  const kpis = [
    { label: 'Total Revenue', hint: 'Awaiting invoice module' },
    { label: 'Outstanding', hint: 'Awaiting invoice module' },
    { label: 'Paid', hint: 'Awaiting payment module' },
    { label: 'Overdue', hint: 'Awaiting invoice module' },
  ];

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-h1 text-ink">Dashboard</h1>
        <p className="mt-1 text-body text-ink-muted">
          {data?.organisation ? data.organisation.organisationName : 'Loading…'}
        </p>
      </header>

      <section aria-label="Key figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((kpi) => (
          <article key={kpi.label} className="rounded-md border border-border bg-surface p-5 shadow-card">
            <h2 className="text-body-sm font-medium text-ink-secondary">{kpi.label}</h2>
            <p className="mt-2 text-h2 tabular text-ink-disabled">—</p>
            <p className="mt-1 text-caption text-ink-muted">{kpi.hint}</p>
          </article>
        ))}
      </section>

      <section className="rounded-md border border-border bg-surface p-6 shadow-card">
        <h2 className="text-h3 text-ink">Phase 1 complete</h2>
        <p className="mt-2 max-w-2xl text-body text-ink-secondary">
          Authentication, organisations, multi-tenant isolation and document numbering are in
          place. Customers, quotations, invoices and payments arrive in Phase 2.
        </p>
      </section>
    </div>
  );
}
