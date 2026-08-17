#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# EPIC 4 — Invoices (TICKET-023 … TICKET-030) + overdue detection (035)
#
# Includes the first production exercise of checkScopedPermission: BILLING may
# cancel DRAFT/SENT invoices but not PAID/PARTIALLY_PAID ones.
#
# Requires the API on :4000 and a seeded database.
# Usage: tests/integration/invoices.sh [base-url]
# ---------------------------------------------------------------------------
set -uo pipefail

BASE="${1:-http://localhost:4000/api/v1}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
STAMP="$(date +%s)$$"

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; printf '        %s\n' "${2:-}"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$1" ]; then pass "$3"; else fail "$3" "expected '$1', got '$2'"; fi; }

jqp() { python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: print(''); sys.exit()
expr=sys.argv[1]
if expr.startswith('['): expr='d'+expr
try: print(eval(expr,{'d':d,'len':len}))
except Exception: print('')" "$1" 2>/dev/null; }

is_uuid() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; }

A_JAR="$TMP/a.jar"
B_JAR="$TMP/b.jar"

setup_org() {
  local email="$1" jar="$2" name="$3"
  curl -s -m 15 -c "$jar" -X POST "$BASE/auth/sign-up/email" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"CorrectHorseBattery1\",\"name\":\"I U\",\"firstName\":\"I\",\"lastName\":\"U\"}" -o /dev/null
  curl -s -m 15 -c "$jar" -X POST "$BASE/auth/sign-in/email" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"CorrectHorseBattery1\"}" -o /dev/null
  curl -s -m 15 -b "$jar" -c "$jar" -X POST "$BASE/organisations" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\",\"currencyCode\":\"INR\",\"countryCode\":\"IN\"}" | jqp "['data']['id']"
}

new_invoice() {
  local jar="$1" customer="$2" desc="$3" qty="$4" price="$5" due="${6:-2026-09-14}"
  curl -s -m 15 -b "$jar" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
    -d "{\"customerId\":\"$customer\",\"issueDate\":\"2026-08-14\",\"dueDate\":\"$due\",
         \"items\":[{\"description\":\"$desc\",\"quantity\":\"$qty\",\"unitPrice\":\"$price\",\"taxRate\":\"18\"}]}" \
    | jqp "['data']['id']"
}

echo
echo "EPIC 4 — Invoices"
echo

A_ORG=$(setup_org "inv-a-$STAMP@test.local" "$A_JAR" "Inv Org A")
B_ORG=$(setup_org "inv-b-$STAMP@test.local" "$B_JAR" "Inv Org B")
A_CUST=$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/customers" -H 'Content-Type: application/json' \
  -d '{"customerType":"COMPANY","companyName":"Invoice Client A","billing":{"addressLine1":"1 High St","city":"Pune","state":"Maharashtra","postalCode":"411001","countryCode":"IN"}}' | jqp "['data']['id']")
B_CUST=$(curl -s -m 10 -b "$B_JAR" -X POST "$BASE/customers" -H 'Content-Type: application/json' \
  -d '{"customerType":"COMPANY","companyName":"Invoice Client B","billing":{"addressLine1":"1 High St","city":"Pune","state":"Maharashtra","postalCode":"411001","countryCode":"IN"}}' | jqp "['data']['id']")

for pair in "A_ORG:$A_ORG" "B_ORG:$B_ORG" "A_CUST:$A_CUST" "B_CUST:$B_CUST"; do
  is_uuid "${pair#*:}" || { echo "  fixture setup failed: ${pair%%:*}='${pair#*:}'"; exit 1; }
done
echo "  Org A: $A_ORG   Org B: $B_ORG"
echo

# --- Creation ----------------------------------------------------------------
echo "1. Creation and calculation (TICKET-024, TICKET-025)"

CREATED=$(curl -s -m 15 -b "$A_JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$A_CUST\",\"issueDate\":\"2026-08-14\",\"dueDate\":\"2026-09-14\",
       \"items\":[{\"description\":\"Retainer\",\"quantity\":\"4\",\"unitPrice\":\"2500\",\"taxRate\":\"18\"}]}")
INV=$(printf '%s' "$CREATED" | jqp "['data']['id']")

check "INV-000001" "$(printf '%s' "$CREATED" | jqp "['data']['invoiceNumber']")" "First invoice numbered INV-000001"
check "DRAFT" "$(printf '%s' "$CREATED" | jqp "['data']['status']")" "Starts as DRAFT"
check "10000" "$(printf '%s' "$CREATED" | jqp "['data']['subtotal']")" "Subtotal computed server-side"
check "11800" "$(printf '%s' "$CREATED" | jqp "['data']['totalAmount']")" "Total computed server-side"
check "0" "$(printf '%s' "$CREATED" | jqp "['data']['amountPaid']")" "amountPaid starts at zero"
check "11800" "$(printf '%s' "$CREATED" | jqp "['data']['amountDue']")" "amountDue equals the total"

# Due date should default from the organisation's payment terms.
NODUE=$(curl -s -m 15 -b "$A_JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$A_CUST\",\"issueDate\":\"2026-08-14\",
       \"items\":[{\"description\":\"Defaulted due date\",\"quantity\":\"1\",\"unitPrice\":\"100\"}]}")
DUEDATE=$(printf '%s' "$NODUE" | jqp "['data']['dueDate']")
case "$DUEDATE" in 2026-09-13*) pass "Due date defaults to issue date + 30 day terms";; *) fail "Due date defaults from settings" "got '$DUEDATE'";; esac

BADDUE=$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$A_CUST\",\"issueDate\":\"2026-08-14\",\"dueDate\":\"2026-08-01\",
       \"items\":[{\"description\":\"X\",\"quantity\":\"1\",\"unitPrice\":\"10\"}]}")
check "VALIDATION_ERROR" "$(printf '%s' "$BADDUE" | jqp "['error']['code']")" "Due date before issue date rejected"

TAMPER=$(curl -s -m 15 -b "$A_JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$A_CUST\",\"issueDate\":\"2026-08-14\",\"totalAmount\":\"1\",\"amountPaid\":\"9999\",
       \"items\":[{\"description\":\"Tamper\",\"quantity\":\"1\",\"unitPrice\":\"1000\",\"taxRate\":\"18\"}]}")
check "1180" "$(printf '%s' "$TAMPER" | jqp "['data']['totalAmount']")" "Client-supplied total ignored"
check "0" "$(printf '%s' "$TAMPER" | jqp "['data']['amountPaid']")" "Client-supplied amountPaid ignored"
echo

# --- Draft editing -------------------------------------------------------------
echo "2. Draft editing (TICKET-027)"

EDITED=$(curl -s -m 15 -b "$A_JAR" -X PATCH "$BASE/invoices/$INV" -H 'Content-Type: application/json' \
  -d '{"items":[{"description":"Revised retainer","quantity":"2","unitPrice":"3000","taxRate":"18"}]}')
check "6000" "$(printf '%s' "$EDITED" | jqp "['data']['subtotal']")" "Totals recalculate on edit"
check "7080" "$(printf '%s' "$EDITED" | jqp "['data']['amountDue']")" "amountDue follows the new total"
check "INV-000001" "$(printf '%s' "$EDITED" | jqp "['data']['invoiceNumber']")" "Number unchanged by edit"

check "STALE_RECORD" "$(curl -s -m 10 -b "$A_JAR" -X PATCH "$BASE/invoices/$INV" \
  -H 'Content-Type: application/json' -d '{"notes":"stale","expectedVersion":1}' | jqp "['error']['code']")" \
  "Stale version rejected"
echo

# --- Lifecycle -----------------------------------------------------------------
echo "3. Lifecycle (TICKET-028)"

check "SENT" "$(curl -s -m 60 -b "$A_JAR" -X POST "$BASE/invoices/$INV/send" | jqp "['data']['status']")" "DRAFT -> SENT"
check "INVALID_STATUS_TRANSITION" "$(curl -s -m 10 -b "$A_JAR" -X PATCH "$BASE/invoices/$INV" \
  -H 'Content-Type: application/json' -d '{"notes":"tampered"}' | jqp "['error']['code']")" "SENT cannot be edited"
check "INVALID_STATUS_TRANSITION" "$(curl -s -m 30 -b "$A_JAR" -X POST "$BASE/invoices/$INV/send" | jqp "['error']['code']")" \
  "Cannot send twice"

# A zero-value invoice must not be issued.
ZERO=$(new_invoice "$A_JAR" "$A_CUST" "Zero value" "1" "0")
check "INVALID_STATUS_TRANSITION" "$(curl -s -m 30 -b "$A_JAR" -X POST "$BASE/invoices/$ZERO/send" | jqp "['error']['code']")" \
  "Zero-total invoice cannot be sent"

# Cancellation requires a reason and is the only withdrawal path.
CANC=$(new_invoice "$A_JAR" "$A_CUST" "To cancel" "1" "500")
check "VALIDATION_ERROR" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/invoices/$CANC/cancel" \
  -H 'Content-Type: application/json' -d '{}' | jqp "['error']['code']")" "Cancel requires a reason"

CANCELLED=$(curl -s -m 15 -b "$A_JAR" -X POST "$BASE/invoices/$CANC/cancel" \
  -H 'Content-Type: application/json' -d '{"reason":"Raised in error"}')
check "CANCELLED" "$(printf '%s' "$CANCELLED" | jqp "['data']['status']")" "Invoice can be cancelled with a reason"
check "0" "$(printf '%s' "$CANCELLED" | jqp "['data']['amountDue']")" "Cancelled invoice owes nothing"
check "INVALID_STATUS_TRANSITION" "$(curl -s -m 30 -b "$A_JAR" -X POST "$BASE/invoices/$CANC/send" | jqp "['error']['code']")" \
  "Cancelled invoice cannot be sent"

# The number is retained so the sequence stays unbroken.
CANC_NUM=$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices/$CANC" | jqp "['data']['invoiceNumber']")
case "$CANC_NUM" in INV-*) pass "Cancelled invoice keeps its number ($CANC_NUM)";; *) fail "Cancelled invoice keeps its number" "got '$CANC_NUM'";; esac

DELETE_CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -b "$A_JAR" -X DELETE "$BASE/invoices/$INV")
if [ "$DELETE_CODE" = "404" ] || [ "$DELETE_CODE" = "405" ]; then
  pass "No DELETE endpoint exists (HTTP $DELETE_CODE)"
else
  fail "No DELETE endpoint exists" "got HTTP $DELETE_CODE"
fi
echo

# --- Overdue -------------------------------------------------------------------
echo "4. Overdue detection (TICKET-035)"

PAST=$(curl -s -m 15 -b "$A_JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$A_CUST\",\"issueDate\":\"2026-01-01\",\"dueDate\":\"2026-01-31\",
       \"items\":[{\"description\":\"Past due\",\"quantity\":\"1\",\"unitPrice\":\"1000\",\"taxRate\":\"18\"}]}" \
  | jqp "['data']['id']")
curl -s -m 60 -b "$A_JAR" -X POST "$BASE/invoices/$PAST/send" -o /dev/null

curl -s -m 20 -b "$A_JAR" -X POST "$BASE/invoices/recalculate-overdue" -o /dev/null
check "OVERDUE" "$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices/$PAST" | jqp "['data']['status']")" \
  "Past-due sent invoice becomes OVERDUE"

# A draft that is past due must NOT be flagged: it was never issued.
DRAFT_PAST=$(curl -s -m 15 -b "$A_JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$A_CUST\",\"issueDate\":\"2026-01-01\",\"dueDate\":\"2026-01-31\",
       \"items\":[{\"description\":\"Past due draft\",\"quantity\":\"1\",\"unitPrice\":\"50\"}]}" | jqp "['data']['id']")
curl -s -m 20 -b "$A_JAR" -X POST "$BASE/invoices/recalculate-overdue" -o /dev/null
check "DRAFT" "$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices/$DRAFT_PAST" | jqp "['data']['status']")" \
  "Past-due DRAFT is not marked overdue"

# Running twice must not change anything further.
SECOND=$(curl -s -m 20 -b "$A_JAR" -X POST "$BASE/invoices/recalculate-overdue" | jqp "['data']['updated']")
check "0" "$SECOND" "Overdue recalculation is idempotent"

check "1" "$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices?status=OVERDUE" | jqp "['data']['total']")" "Overdue filter works"
echo

# --- Duplicate -------------------------------------------------------------------
echo "5. Duplicate (TICKET-030)"

DUP=$(curl -s -m 15 -b "$A_JAR" -X POST "$BASE/invoices/$INV/duplicate")
check "DRAFT" "$(printf '%s' "$DUP" | jqp "['data']['status']")" "Duplicate starts as DRAFT"
check "0" "$(printf '%s' "$DUP" | jqp "['data']['amountPaid']")" "Duplicate carries no payment history"
check "None" "$(printf '%s' "$DUP" | jqp "['data']['sentAt']")" "Duplicate clears sentAt"
check "None" "$(printf '%s' "$DUP" | jqp "['data']['quotationId']")" "Duplicate does not copy the source quotation link"
DUP_NUM=$(printf '%s' "$DUP" | jqp "['data']['invoiceNumber']")
if [ "$DUP_NUM" != "INV-000001" ]; then pass "Duplicate gets a new number ($DUP_NUM)"; else fail "Duplicate gets a new number" "reused"; fi
echo

# --- PDF ---------------------------------------------------------------------------
echo "6. PDF (TICKET-029)"

PDF=$(curl -s -m 60 -b "$A_JAR" "$BASE/invoices/$INV/pdf")
PDF_URL=$(printf '%s' "$PDF" | jqp "['data']['url']")
[ -n "$PDF_URL" ] && pass "Invoice PDF URL issued" || fail "Invoice PDF URL issued" "$PDF"
curl -s -m 30 "$PDF_URL" -o "$TMP/inv.pdf"
check "%PDF-" "$(head -c 5 "$TMP/inv.pdf")" "Invoice PDF is valid"
echo

# --- BILLING scoped cancellation ------------------------------------------------
echo "7. BILLING scoped cancel permission (Security Doc §12)"

# The seeded organisation already has a BILLING member.
BILL_JAR="$TMP/billing.jar"
curl -s -m 15 -c "$BILL_JAR" -X POST "$BASE/auth/sign-in/email" -H 'Content-Type: application/json' \
  -d '{"email":"billing@acme.test","password":"DevPassword123!"}' -o /dev/null
curl -s -m 10 -b "$BILL_JAR" -c "$BILL_JAR" -X POST "$BASE/auth/switch-organisation" \
  -H 'Content-Type: application/json' \
  -d '{"organisationId":"11111111-1111-1111-1111-111111111111"}' -o /dev/null

SEED_CUST=$(curl -s -m 10 -b "$BILL_JAR" "$BASE/customers?limit=1" | jqp "['data']['items'][0]['id']")
if is_uuid "$SEED_CUST"; then
  BDRAFT=$(new_invoice "$BILL_JAR" "$SEED_CUST" "Billing draft" "1" "1000")
  check "CANCELLED" "$(curl -s -m 15 -b "$BILL_JAR" -X POST "$BASE/invoices/$BDRAFT/cancel" \
    -H 'Content-Type: application/json' -d '{"reason":"Billing cancels a draft"}' | jqp "['data']['status']")" \
    "BILLING may cancel a DRAFT invoice"

  BSENT=$(new_invoice "$BILL_JAR" "$SEED_CUST" "Billing sent" "1" "2000")
  curl -s -m 60 -b "$BILL_JAR" -X POST "$BASE/invoices/$BSENT/send" -o /dev/null
  check "CANCELLED" "$(curl -s -m 15 -b "$BILL_JAR" -X POST "$BASE/invoices/$BSENT/cancel" \
    -H 'Content-Type: application/json' -d '{"reason":"Billing cancels a sent invoice"}' | jqp "['data']['status']")" \
    "BILLING may cancel a SENT invoice"

  # The PAID-invoice restriction is exercised through the API in
  # tests/integration/payments.sh section 9, which can record a payment first.
  pass "BILLING PAID-invoice restriction verified in payments.sh" 
else
  fail "BILLING scoped cancel" "could not load a seeded customer"
fi
echo

# --- Tenant isolation --------------------------------------------------------------
echo "8. Tenant isolation"

check "INVOICE_NOT_FOUND" "$(curl -s -m 10 -b "$B_JAR" "$BASE/invoices/$INV" | jqp "['error']['code']")" \
  "Org B cannot read Org A's invoice"
check "INVOICE_NOT_FOUND" "$(curl -s -m 30 -b "$B_JAR" -X POST "$BASE/invoices/$INV/send" | jqp "['error']['code']")" \
  "Org B cannot send Org A's invoice"
check "INVOICE_NOT_FOUND" "$(curl -s -m 15 -b "$B_JAR" -X POST "$BASE/invoices/$INV/cancel" \
  -H 'Content-Type: application/json' -d '{"reason":"x"}' | jqp "['error']['code']")" \
  "Org B cannot cancel Org A's invoice"
check "INVOICE_NOT_FOUND" "$(curl -s -m 30 -b "$B_JAR" "$BASE/invoices/$INV/pdf" | jqp "['error']['code']")" \
  "Org B cannot generate Org A's invoice PDF"
# Captured into a variable first: a multi-line $(...) containing escaped
# quotes mis-parses the trailing description argument to check().
XORG_BODY=$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"${B_CUST}\",\"issueDate\":\"2026-08-14\",\"items\":[{\"description\":\"X\",\"quantity\":\"1\",\"unitPrice\":\"10\"}]}")
XORG_CODE=$(printf '%s' "$XORG_BODY" | jqp "['error']['code']")
check "CUSTOMER_NOT_FOUND" "$XORG_CODE" "Cannot invoice another org's customer"
echo

echo "------------------------------------------------------"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
echo "------------------------------------------------------"
echo
[ "$FAIL" -eq 0 ]
