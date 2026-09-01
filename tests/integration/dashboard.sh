#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# EPIC 7 — Dashboard (TICKET-039, TICKET-040)
#
# The point of these tests is not that the endpoint returns numbers, but that
# the numbers AGREE with the underlying records. A KPI that contradicts the
# invoice list is worse than no KPI: it silently teaches people to distrust
# both. Each figure is therefore cross-checked against the module endpoints
# a user would drill into.
#
# Requires the API on :4000.
# Usage: tests/integration/dashboard.sh [base-url]
# ---------------------------------------------------------------------------
set -uo pipefail

# Per-request timeout. 10s suits a local database; a hosted one in another
# region needs far more — a simple list query measured 5-7s against Seoul,
# so multi-query endpoints exceed 10s without anything being wrong.
REQ_TIMEOUT="${REQ_TIMEOUT:-10}"

BASE="${1:-http://localhost:4000/api/v1}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
STAMP="$(date +%s)$$"
TODAY="$(date -u +%Y-%m-%d)"

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; printf '        %s\n' "${2:-}"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$1" ]; then pass "$3"; else fail "$3" "expected '$1', got '$2'"; fi; }

jqp() { python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: print(''); sys.exit()
expr=sys.argv[1]
if expr.startswith('['): expr='d'+expr
try: print(eval(expr,{'d':d,'len':len,'sum':sum,'float':float,'round':round}))
except Exception: print('')" "$1" 2>/dev/null; }

is_uuid() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; }
num() { printf '%.2f' "${1:-0}" 2>/dev/null || printf '0.00'; }

JAR="$TMP/a.jar"
EMAIL="dash-$STAMP@test.local"

curl -s -m "$REQ_TIMEOUT" -c "$JAR" -X POST "$BASE/auth/sign-up/email" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"CorrectHorseBattery1\",\"name\":\"D U\",\"firstName\":\"D\",\"lastName\":\"U\"}" -o /dev/null
curl -s -m "$REQ_TIMEOUT" -c "$JAR" -X POST "$BASE/auth/sign-in/email" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"CorrectHorseBattery1\"}" -o /dev/null
ORG=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" -c "$JAR" -X POST "$BASE/organisations" -H 'Content-Type: application/json' \
  -d '{"name":"Dashboard Org","currencyCode":"INR","countryCode":"IN"}' | jqp "['data']['id']")
CUST=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" -X POST "$BASE/customers" -H 'Content-Type: application/json' \
  -d '{"customerType":"COMPANY","companyName":"Dashboard Client","billing":{"addressLine1":"1 High St","city":"Pune","state":"Maharashtra","postalCode":"411001","countryCode":"IN"}}' | jqp "['data']['id']")

is_uuid "$ORG" && is_uuid "$CUST" || { echo "  fixture setup failed"; exit 1; }

echo
echo "EPIC 7 — Dashboard"
echo

# --- Empty organisation ----------------------------------------------------------
echo "1. A brand-new organisation (no-data case)"

EMPTY=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/dashboard/summary")
check "0.0000" "$(printf '%s' "$EMPTY" | jqp "['data']['totals']['totalInvoiced']")" "Total invoiced starts at zero"
check "0.0000" "$(printf '%s' "$EMPTY" | jqp "['data']['totals']['outstanding']")" "Outstanding starts at zero"
check "0.0000" "$(printf '%s' "$EMPTY" | jqp "['data']['totals']['overdue']")" "Overdue starts at zero"
check "0" "$(printf '%s' "$EMPTY" | jqp "['data']['counts']['outstandingInvoices']")" "No outstanding invoices"
check "INR" "$(printf '%s' "$EMPTY" | jqp "['data']['currency']")" "Currency comes from the organisation"

EMPTY_RECENT=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/dashboard/recent")
check "0" "$(printf '%s' "$EMPTY_RECENT" | jqp "len(d['data']['invoices'])")" "Recent invoices is empty, not an error"
check "0" "$(printf '%s' "$EMPTY_RECENT" | jqp "len(d['data']['quotations'])")" "Recent quotations is empty"
echo

# --- Drafts are excluded -----------------------------------------------------------
echo "2. Drafts do not count as invoiced"

DRAFT=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$CUST\",\"paymentMethod\":\"BANK_TRANSFER\",\"issueDate\":\"$TODAY\",
       \"items\":[{\"description\":\"Draft work\",\"quantity\":\"1\",\"unitPrice\":\"5000\",\"taxRate\":\"0\"}]}" \
  | jqp "['data']['id']")

AFTER_DRAFT=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/dashboard/summary")
check "0.0000" "$(printf '%s' "$AFTER_DRAFT" | jqp "['data']['totals']['totalInvoiced']")" \
  "A draft is not counted as invoiced"
check "1" "$(printf '%s' "$AFTER_DRAFT" | jqp "['data']['counts']['draftInvoices']")" "Draft count reflects it"
check "1" "$(printf '%s' "$AFTER_DRAFT" | jqp "len(d['data']['invoices'])" <<< "$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/dashboard/recent")")" \
  "Draft still appears under recent invoices"
echo

# --- Sending moves it into the totals -------------------------------------------------
echo "3. Sending an invoice updates the KPIs"

curl -s -m "$REQ_TIMEOUT" -b "$JAR" -X POST "$BASE/invoices/$DRAFT/send" -o /dev/null
SENT=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/dashboard/summary")
check "5000.0000" "$(printf '%s' "$SENT" | jqp "['data']['totals']['totalInvoiced']")" "Sent invoice counts as invoiced"
check "5000.0000" "$(printf '%s' "$SENT" | jqp "['data']['totals']['outstanding']")" "Full amount is outstanding"
check "0.0000" "$(printf '%s' "$SENT" | jqp "['data']['totals']['totalPaid']")" "Nothing paid yet"
check "1" "$(printf '%s' "$SENT" | jqp "['data']['counts']['outstandingInvoices']")" "Outstanding count is 1"
check "0" "$(printf '%s' "$SENT" | jqp "['data']['counts']['draftInvoices']")" "No longer counted as a draft"
echo

# --- Payments move the needle ----------------------------------------------------------
echo "4. Payments update totals (TICKET-039 acceptance)"

curl -s -m "$REQ_TIMEOUT" -b "$JAR" -X POST "$BASE/invoices/$DRAFT/payments" -H 'Content-Type: application/json' \
  -d "{\"amount\":\"2000\",\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"CASH\",\"idempotencyKey\":\"dash-part-$STAMP\"}" -o /dev/null

PART=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/dashboard/summary")
check "5000.0000" "$(printf '%s' "$PART" | jqp "['data']['totals']['totalInvoiced']")" "Invoiced total unchanged by a payment"
check "2000.0000" "$(printf '%s' "$PART" | jqp "['data']['totals']['totalPaid']")" "Paid total reflects the payment"
check "3000.0000" "$(printf '%s' "$PART" | jqp "['data']['totals']['outstanding']")" "Outstanding drops by the payment"

# Settle it.
curl -s -m "$REQ_TIMEOUT" -b "$JAR" -X POST "$BASE/invoices/$DRAFT/payments" -H 'Content-Type: application/json' \
  -d "{\"amount\":\"3000\",\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"CASH\",\"idempotencyKey\":\"dash-final-$STAMP\"}" -o /dev/null

FULL=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/dashboard/summary")
check "5000.0000" "$(printf '%s' "$FULL" | jqp "['data']['totals']['totalPaid']")" "Paid equals the invoice total once settled"
check "0.0000" "$(printf '%s' "$FULL" | jqp "['data']['totals']['outstanding']")" "Outstanding returns to zero"
check "0" "$(printf '%s' "$FULL" | jqp "['data']['counts']['outstandingInvoices']")" "No invoices awaiting payment"
echo

# --- Overdue ----------------------------------------------------------------------------
echo "5. Overdue detection (TICKET-039, TICKET-035)"

PAST=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$CUST\",\"paymentMethod\":\"BANK_TRANSFER\",\"issueDate\":\"2026-01-01\",\"dueDate\":\"2026-01-31\",
       \"items\":[{\"description\":\"Late work\",\"quantity\":\"1\",\"unitPrice\":\"8000\",\"taxRate\":\"0\"}]}" \
  | jqp "['data']['id']")
curl -s -m "$REQ_TIMEOUT" -b "$JAR" -X POST "$BASE/invoices/$PAST/send" -o /dev/null

# Deliberately WITHOUT running recalculate-overdue: the dashboard computes
# overdue from the due date, so the figure must be right even when the
# scheduled status sweep has not run.
OD=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/dashboard/summary")
check "8000.0000" "$(printf '%s' "$OD" | jqp "['data']['totals']['overdue']")" \
  "Overdue is computed from the due date, not the status column"
check "1" "$(printf '%s' "$OD" | jqp "['data']['counts']['overdueInvoices']")" "Overdue count is correct"
check "8000.0000" "$(printf '%s' "$OD" | jqp "['data']['totals']['outstanding']")" "Overdue is also counted as outstanding"

# A settled invoice can never be overdue, however old.
OLD_PAID=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$CUST\",\"paymentMethod\":\"BANK_TRANSFER\",\"issueDate\":\"2026-01-01\",\"dueDate\":\"2026-01-15\",
       \"items\":[{\"description\":\"Old but paid\",\"quantity\":\"1\",\"unitPrice\":\"1000\",\"taxRate\":\"0\"}]}" \
  | jqp "['data']['id']")
curl -s -m "$REQ_TIMEOUT" -b "$JAR" -X POST "$BASE/invoices/$OLD_PAID/send" -o /dev/null
curl -s -m "$REQ_TIMEOUT" -b "$JAR" -X POST "$BASE/invoices/$OLD_PAID/payments" -H 'Content-Type: application/json' \
  -d "{\"amount\":\"1000\",\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"CASH\",\"idempotencyKey\":\"dash-old-$STAMP\"}" -o /dev/null

OD2=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/dashboard/summary")
check "8000.0000" "$(printf '%s' "$OD2" | jqp "['data']['totals']['overdue']")" \
  "A paid invoice past its due date is not overdue"
echo

# --- Cancellation -------------------------------------------------------------------------
echo "6. Cancelled invoices leave the totals"

CANC=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$CUST\",\"paymentMethod\":\"BANK_TRANSFER\",\"issueDate\":\"$TODAY\",
       \"items\":[{\"description\":\"To cancel\",\"quantity\":\"1\",\"unitPrice\":\"4000\",\"taxRate\":\"0\"}]}" \
  | jqp "['data']['id']")
curl -s -m "$REQ_TIMEOUT" -b "$JAR" -X POST "$BASE/invoices/$CANC/send" -o /dev/null

BEFORE_CANCEL=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/dashboard/summary" | jqp "['data']['totals']['totalInvoiced']")
curl -s -m "$REQ_TIMEOUT" -b "$JAR" -X POST "$BASE/invoices/$CANC/cancel" -H 'Content-Type: application/json' \
  -d '{"reason":"Dashboard test cancellation"}' -o /dev/null
AFTER_CANCEL=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/dashboard/summary" | jqp "['data']['totals']['totalInvoiced']")

EXPECTED=$(python3 -c "print(f\"{float('$BEFORE_CANCEL')-4000:.4f}\")")
check "$EXPECTED" "$AFTER_CANCEL" "Cancelling removes the invoice from the invoiced total"
echo

# --- Cross-check against the module endpoints -------------------------------------------------
echo "7. KPIs agree with the underlying records"

SUM=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/dashboard/summary")
DASH_OUT=$(num "$(printf '%s' "$SUM" | jqp "['data']['totals']['outstanding']")")
DASH_COUNT=$(printf '%s' "$SUM" | jqp "['data']['counts']['outstandingInvoices']")

# Sum the balances the invoice list itself reports.
LIST_OUT=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/invoices?outstanding=true&limit=100" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print(f\"{sum(float(i['amountDue']) for i in d['items']):.2f}\")" 2>/dev/null)
LIST_COUNT=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/invoices?outstanding=true&limit=100" | jqp "['data']['total']")

check "$LIST_OUT" "$DASH_OUT" "Dashboard outstanding equals the sum of the invoice list"
check "$LIST_COUNT" "$DASH_COUNT" "Dashboard outstanding count equals the list total"

# Total paid must equal the sum of RECORDED payments.
DASH_PAID=$(num "$(printf '%s' "$SUM" | jqp "['data']['totals']['totalPaid']")")
PAY_TOTAL=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/payments?status=RECORDED&limit=100" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print(f\"{sum(float(p['amount']) for p in d['items']):.2f}\")" 2>/dev/null)
check "$PAY_TOTAL" "$DASH_PAID" "Dashboard paid equals the sum of recorded payments"
echo

# --- Recent documents ---------------------------------------------------------------------------
echo "8. Recent documents (TICKET-040)"

QUOTE=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" -X POST "$BASE/quotations" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$CUST\",\"paymentMethod\":\"BANK_TRANSFER\",\"issueDate\":\"$TODAY\",
       \"items\":[{\"description\":\"Pipeline work\",\"quantity\":\"1\",\"unitPrice\":\"30000\",\"taxRate\":\"0\"}]}" \
  | jqp "['data']['id']")
curl -s -m "$REQ_TIMEOUT" -b "$JAR" -X POST "$BASE/quotations/$QUOTE/send" -o /dev/null

RECENT=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/dashboard/recent")
check "1" "$(printf '%s' "$RECENT" | jqp "len(d['data']['quotations'])")" "Recent quotations includes the new one"
check "SENT" "$(printf '%s' "$RECENT" | jqp "['data']['quotations'][0]['status']")" "Correct status is shown"
check "Dashboard Client" "$(printf '%s' "$RECENT" | jqp "['data']['quotations'][0]['customer']['companyName']")" \
  "Customer is included so the row is identifiable"

# Outstanding list must be ordered oldest-due first — the collections worklist.
DUE_ORDER=$(printf '%s' "$RECENT" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']['outstandingInvoices']
dates=[i['dueDate'] for i in d]
print('sorted' if dates==sorted(dates) else 'unsorted')" 2>/dev/null)
check "sorted" "$DUE_ORDER" "Outstanding invoices are ordered by due date, oldest first"

# Pipeline value must match the quotations that are actually open.
PIPE=$(curl -s -m "$REQ_TIMEOUT" -b "$JAR" "$BASE/dashboard/summary" | jqp "['data']['quotationPipeline']['openValue']")
check "30000.0000" "$PIPE" "Quotation pipeline value reflects sent quotations"
echo

# --- Isolation -------------------------------------------------------------------------------------
echo "9. Dashboard is organisation-scoped"

B_JAR="$TMP/b.jar"
curl -s -m "$REQ_TIMEOUT" -c "$B_JAR" -X POST "$BASE/auth/sign-up/email" -H 'Content-Type: application/json' \
  -d "{\"email\":\"dashb-$STAMP@test.local\",\"password\":\"CorrectHorseBattery1\",\"name\":\"D B\",\"firstName\":\"D\",\"lastName\":\"B\"}" -o /dev/null
curl -s -m "$REQ_TIMEOUT" -c "$B_JAR" -X POST "$BASE/auth/sign-in/email" -H 'Content-Type: application/json' \
  -d "{\"email\":\"dashb-$STAMP@test.local\",\"password\":\"CorrectHorseBattery1\"}" -o /dev/null
curl -s -m "$REQ_TIMEOUT" -b "$B_JAR" -c "$B_JAR" -X POST "$BASE/organisations" -H 'Content-Type: application/json' \
  -d '{"name":"Other Dashboard Org","currencyCode":"INR","countryCode":"IN"}' -o /dev/null

B_SUM=$(curl -s -m "$REQ_TIMEOUT" -b "$B_JAR" "$BASE/dashboard/summary")
check "0.0000" "$(printf '%s' "$B_SUM" | jqp "['data']['totals']['totalInvoiced']")" \
  "A second organisation sees none of the first's totals"
check "0" "$(printf '%s' "$B_SUM" | jqp "['data']['counts']['outstandingInvoices']")" \
  "And none of its outstanding invoices"
check "0" "$(curl -s -m "$REQ_TIMEOUT" -b "$B_JAR" "$BASE/dashboard/recent" | jqp "len(d['data']['invoices'])")" \
  "And none of its recent documents"

check "401" "$(curl -s -m "$REQ_TIMEOUT" -o /dev/null -w '%{http_code}' "$BASE/dashboard/summary")" \
  "Anonymous access is refused"
echo

echo "------------------------------------------------------"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
echo "------------------------------------------------------"
echo
[ "$FAIL" -eq 0 ]
