/**
 * Shared vocabulary for "what counts as money".
 *
 * The dashboard and the reports must agree. Two copies of these lists would
 * drift the moment a status is added, and the symptom would be a dashboard and
 * a report quoting different totals for the same organisation — the kind of
 * disagreement that destroys trust in a billing system.
 */

/** Billed money: issued and not withdrawn. Excludes DRAFT and CANCELLED. */
export const LIVE_INVOICE_STATUSES = ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] as const;

/** Still owed: billed, not yet settled. Excludes PAID. */
export const COLLECTABLE_STATUSES = ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] as const;

/**
 * Today at UTC midnight.
 *
 * Due dates are stored as DATE, so comparing against a timestamp with a time
 * component would make an invoice due today read as overdue for most of it.
 */
export function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
