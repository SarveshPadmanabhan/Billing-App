#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Financial integrity check
#
# Asserts, directly against the database, the invariants the application is
# supposed to maintain. Unlike the other suites this does not exercise
# endpoints — it audits the resulting *state*, so it catches drift no matter
# how it arrived: a bug, a partial failure, or a careless manual repair.
#
# Written after a cleanup script of mine deleted payment rows out from under
# four invoices, leaving amount_paid pointing at allocations that no longer
# existed. The application had behaved correctly throughout; nothing in the
# test suite would have noticed the damage.
#
# Run it last, after the other suites have generated data.
# Usage: tests/integration/integrity.sh
# ---------------------------------------------------------------------------
set -uo pipefail

export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
DB_NAME="${DB_NAME:-billing_dev}"
DB_HOST="${DB_HOST:-localhost}"

# An integrity audit must see every tenant, which billing_owner cannot do:
# the tables use FORCE ROW LEVEL SECURITY, so even the owner is filtered and
# `SET row_security = off` is refused. Connect as a BYPASSRLS role instead,
# which is appropriate for an audit and only ever reads.
DB_SUPERUSER="${DB_SUPERUSER:-$(whoami)}"

# Audit whatever DATABASE_MIGRATION_URL points at, so this follows the app to a
# hosted database instead of silently auditing a stale local copy. That is not
# hypothetical: after the move to Supabase this script reported 34/34 while
# reading 120 organisations of old local test data.
AUDIT_URL="${AUDIT_URL:-}"
if [ -z "$AUDIT_URL" ] && [ -f "$(dirname "$0")/../../.env" ]; then
  AUDIT_URL=$(grep -E "^DATABASE_MIGRATION_URL=" "$(dirname "$0")/../../.env" | head -1 | cut -d= -f2-)
fi

# psql takes either a URL or host/user/db flags; build the argument list once.
if [ -n "$AUDIT_URL" ]; then
  PSQL_TARGET=("$AUDIT_URL")
  AUDIT_LABEL=$(printf '%s' "$AUDIT_URL" | sed -E 's|://([^:]+):[^@]*@|://\1:***@|')
else
  PSQL_TARGET=(-h "$DB_HOST" -U "$DB_SUPERUSER" -d "$DB_NAME")
  AUDIT_LABEL="$DB_NAME on $DB_HOST as $DB_SUPERUSER"
fi

PASS=0
FAIL=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; printf '        %s\n' "${2:-}"; FAIL=$((FAIL + 1)); }

# Errors are deliberately NOT suppressed. The first version of this file hid
# them with 2>/dev/null, so a query that failed returned an empty string that
# arithmetic treated as 0 — every check "passed" while auditing nothing. Any
# non-numeric result is now reported as a failure, not a clean bill of health.
count_all() {
  local sql="$1"
  local out
  out=$(psql "${PSQL_TARGET[@]}" -tAc "$sql" 2>&1)

  if ! printf '%s' "$out" | grep -qE '^[[:space:]]*[0-9]+[[:space:]]*$'; then
    printf 'QUERY_ERROR: %s' "$(printf '%s' "$out" | head -2 | tr '\n' ' ')"
    return
  fi
  printf '%s' "$out" | tr -d ' '
}

# Self-check: prove the audit can actually see data before trusting any result.
ORG_COUNT=$(count_all "SELECT count(*) FROM organisations;")
case "$ORG_COUNT" in
  QUERY_ERROR*|0)
    echo "  Cannot read $AUDIT_LABEL ($ORG_COUNT)."
    echo "  An audit that cannot see rows would report zero violations and be worthless."
    exit 1
    ;;
esac

expect_zero() {
  local actual="$1" label="$2"
  case "$actual" in
    0)            pass "$label" ;;
    QUERY_ERROR*) fail "$label" "check could not run — $actual" ;;
    *)            fail "$label" "$actual violation(s) found" ;;
  esac
}

echo
echo "Financial integrity"
echo "  auditing $ORG_COUNT organisation(s) in $AUDIT_LABEL"
echo

# --- Balances -------------------------------------------------------------------
echo "1. Invoice balances"

# The core invariant behind ADR-009's ledger principle: the stored aggregate
# must equal the sum of its source rows.
expect_zero "$(count_all "
  SELECT count(*) FROM (
    SELECT i.id FROM invoices i
    LEFT JOIN payment_allocations pa ON pa.invoice_id = i.id
    LEFT JOIN payments p ON p.id = pa.payment_id
    GROUP BY i.id, i.amount_paid
    HAVING i.amount_paid <> COALESCE(SUM(pa.allocated_amount) FILTER (WHERE p.status = 'RECORDED'), 0)
  ) x;")" "amount_paid equals the sum of RECORDED allocations"

expect_zero "$(count_all "
  SELECT count(*) FROM invoices
  WHERE status <> 'CANCELLED' AND total_amount - amount_paid <> amount_due;")" \
  "total - paid = due on every live invoice"

expect_zero "$(count_all "
  SELECT count(*) FROM invoices WHERE amount_due < 0 OR amount_paid < 0;")" \
  "No negative balances"

expect_zero "$(count_all "
  SELECT count(*) FROM invoices WHERE amount_paid > total_amount;")" \
  "No invoice is overpaid"

expect_zero "$(count_all "
  SELECT count(*) FROM invoices WHERE status = 'CANCELLED' AND amount_due <> 0;")" \
  "Cancelled invoices owe nothing"

expect_zero "$(count_all "
  SELECT count(*) FROM invoices WHERE status = 'PAID' AND amount_due <> 0;")" \
  "PAID invoices have a zero balance"
echo

# --- Line items -------------------------------------------------------------------
echo "2. Document totals match their line items"

# subtotal must equal the sum of line nets (line_total - tax_amount).
expect_zero "$(count_all "
  SELECT count(*) FROM (
    SELECT i.id
    FROM invoices i JOIN invoice_items it ON it.invoice_id = i.id
    GROUP BY i.id, i.subtotal, i.discount_amount
    HAVING ABS(i.subtotal - SUM(it.line_total - it.tax_amount)) > 0.01
       AND i.discount_amount = 0
  ) x;")" "Invoice subtotal matches its line items"

expect_zero "$(count_all "
  SELECT count(*) FROM (
    SELECT q.id
    FROM quotations q JOIN quotation_items qi ON qi.quotation_id = q.id
    GROUP BY q.id, q.subtotal, q.discount_amount
    HAVING ABS(q.subtotal - SUM(qi.line_total - qi.tax_amount)) > 0.01
       AND q.discount_amount = 0
  ) x;")" "Quotation subtotal matches its line items"

expect_zero "$(count_all "
  SELECT count(*) FROM invoices
  WHERE ABS(total_amount - (subtotal - discount_amount + tax_amount)) > 0.01;")" \
  "Invoice total = subtotal - discount + tax"

expect_zero "$(count_all "
  SELECT count(*) FROM quotations
  WHERE ABS(total_amount - (subtotal - discount_amount + tax_amount)) > 0.01;")" \
  "Quotation total = subtotal - discount + tax"

expect_zero "$(count_all "
  SELECT count(*) FROM invoices i
  WHERE NOT EXISTS (SELECT 1 FROM invoice_items it WHERE it.invoice_id = i.id);")" \
  "No invoice exists without line items"
echo

# --- Numbering ----------------------------------------------------------------------
echo "3. Document numbering"

# Scoped by company, not organisation: numbering is per company, so two
# companies legitimately both hold INV-000001. An organisation-scoped check
# would report that correct state as a duplicate.
expect_zero "$(count_all "
  SELECT count(*) FROM (SELECT company_id, invoice_number FROM invoices GROUP BY 1,2 HAVING count(*)>1) x;")" \
  "No duplicate invoice numbers within a company"

expect_zero "$(count_all "
  SELECT count(*) FROM (SELECT company_id, quotation_number FROM quotations GROUP BY 1,2 HAVING count(*)>1) x;")" \
  "No duplicate quotation numbers within a company"

expect_zero "$(count_all "
  SELECT count(*) FROM (SELECT company_id, payment_number FROM payments GROUP BY 1,2 HAVING count(*)>1) x;")" \
  "No duplicate payment numbers within a company"

# The sequence must never sit behind the documents already issued, or the next
# document would collide.
expect_zero "$(count_all "
  SELECT count(*) FROM document_sequences ds
  WHERE ds.document_type = 'INVOICE'
    AND ds.current_number < (SELECT count(*) FROM invoices i WHERE i.company_id = ds.company_id);")" \
  "Invoice sequence is not behind the issued count"

# Every company must hold all three sequences. A company without them cannot
# issue documents, and the failure only surfaces at the first invoice.
expect_zero "$(count_all "
  SELECT count(*) FROM companies c
  CROSS JOIN (VALUES ('INVOICE'::document_number_type),
                     ('QUOTATION'::document_number_type),
                     ('PAYMENT'::document_number_type)) AS t(document_type)
  WHERE NOT c.is_archived
    AND NOT EXISTS (SELECT 1 FROM document_sequences ds
                    WHERE ds.company_id = c.id AND ds.document_type = t.document_type);")" \
  "Every company has all three document sequences"

# A company must never point outside its organisation, and neither may any
# document. This is the join that would silently leak data across tenants.
expect_zero "$(count_all "
  SELECT (SELECT count(*) FROM invoices i JOIN companies c ON c.id=i.company_id
            WHERE c.organisation_id <> i.organisation_id)
       + (SELECT count(*) FROM quotations q JOIN companies c ON c.id=q.company_id
            WHERE c.organisation_id <> q.organisation_id)
       + (SELECT count(*) FROM payments p JOIN companies c ON c.id=p.company_id
            WHERE c.organisation_id <> p.organisation_id)
       + (SELECT count(*) FROM customers cu JOIN companies c ON c.id=cu.company_id
            WHERE c.organisation_id <> cu.organisation_id);")" \
  "No record belongs to a company from another organisation"

# Exactly one default company per organisation, matching the partial unique
# index. Zero defaults would leave new sessions with no company to fall back to.
# Counted from organisations, not from companies. Grouping the companies
# table only sees organisations that HAVE a default, so an organisation with
# zero defaults produces no group and vanishes from the result — the check
# would pass precisely in the case it exists to catch.
# --- Stock ---------------------------------------------------------------------------
echo "5. Stock"

# The ledger is the truth; quantity_on_hand is a cache of it. Any disagreement
# means something incremented the column instead of recomputing it.
expect_zero "$(count_all "
  SELECT count(*) FROM stock_items si
  WHERE si.quantity_on_hand <> (
    SELECT COALESCE(SUM(CASE sm.movement_type
                          WHEN 'IN'         THEN sm.quantity
                          WHEN 'ADJUSTMENT' THEN sm.quantity
                          ELSE -sm.quantity END), 0)
      FROM stock_movements sm WHERE sm.stock_item_id = si.id);")" \
  "quantity_on_hand matches the movement ledger"

# Negative stock means a deduction escaped the availability check.
expect_zero "$(count_all "
  SELECT count(*) FROM stock_items WHERE tracks_stock AND quantity_on_hand < 0;")" \
  "No tracked item holds a negative quantity"

# Movement quantities are always positive; direction lives in movement_type.
expect_zero "$(count_all "
  SELECT count(*) FROM stock_movements WHERE quantity <= 0;")" \
  "No movement has a zero or negative quantity"

# One OUT per item per invoice. A second would mean a retried send deducted twice.
expect_zero "$(count_all "
  SELECT count(*) FROM (
    SELECT invoice_id, stock_item_id FROM stock_movements
     WHERE invoice_id IS NOT NULL AND movement_type = 'OUT'
     GROUP BY 1,2 HAVING count(*) > 1) x;")" \
  "No invoice deducted the same item twice"

# A movement must never cross into another organisation's item or company.
expect_zero "$(count_all "
  SELECT count(*) FROM stock_movements sm
  JOIN stock_items si ON si.id = sm.stock_item_id
  WHERE si.organisation_id <> sm.organisation_id OR si.company_id <> sm.company_id;")" \
  "No movement crosses an organisation or company boundary"
echo

expect_zero "$(count_all "
  SELECT count(*) FROM organisations o
  WHERE (SELECT count(*) FROM companies c
          WHERE c.organisation_id = o.id AND c.is_default) <> 1;")" \
  "Each organisation has exactly one default company"
echo

# --- Referential integrity -------------------------------------------------------------
echo "4. Cross-record consistency"

expect_zero "$(count_all "
  SELECT count(*) FROM payment_allocations pa
  JOIN payments p ON p.id = pa.payment_id
  JOIN invoices i ON i.id = pa.invoice_id
  WHERE p.organisation_id <> i.organisation_id;")" \
  "No allocation joins a payment and invoice from different organisations"

expect_zero "$(count_all "
  SELECT count(*) FROM invoices i
  JOIN customers c ON c.id = i.customer_id
  WHERE c.organisation_id <> i.organisation_id;")" \
  "No invoice references another organisation's customer"

expect_zero "$(count_all "
  SELECT count(*) FROM invoices i
  JOIN quotations q ON q.id = i.quotation_id
  WHERE q.organisation_id <> i.organisation_id;")" \
  "No invoice references another organisation's quotation"

# A converted quotation must have produced exactly one invoice.
expect_zero "$(count_all "
  SELECT count(*) FROM (
    SELECT q.id FROM quotations q
    LEFT JOIN invoices i ON i.quotation_id = q.id
    WHERE q.status = 'CONVERTED'
    GROUP BY q.id
    HAVING count(i.id) <> 1
  ) x;")" "Each CONVERTED quotation has exactly one invoice"

expect_zero "$(count_all "
  SELECT count(*) FROM payments WHERE status = 'VOIDED' AND voided_at IS NULL;")" \
  "Every voided payment records when it was voided"

expect_zero "$(count_all "
  SELECT count(*) FROM invoices WHERE status = 'CANCELLED' AND cancelled_reason IS NULL;")" \
  "Every cancelled invoice records a reason"
echo

# --- Tenancy ----------------------------------------------------------------------------
echo "5. Tenant columns are populated"

for table in customers quotations invoices payments documents; do
  expect_zero "$(count_all "SELECT count(*) FROM $table WHERE organisation_id IS NULL;")" \
    "$table.organisation_id is never null"
done
echo

echo "------------------------------------------------------"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
echo "------------------------------------------------------"
echo
[ "$FAIL" -eq 0 ]
