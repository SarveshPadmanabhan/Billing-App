export default function PaymentsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-h1 text-ink">Payments</h1>
      </header>

      <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-border bg-surface p-12 text-center shadow-card">
        <h2 className="text-h4 text-ink">Coming in Phase 2</h2>
        <p className="max-w-md text-body text-ink-muted">
          This module is reachable from the navigation. Its functionality is delivered by the
          Phase 2 tickets.
        </p>
      </div>
    </div>
  );
}
