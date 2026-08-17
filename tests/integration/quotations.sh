#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# EPIC 3 — Quotations (TICKET-014 … TICKET-022)
#
# Requires the API on :4000 and a seeded database.
# Usage: tests/integration/quotations.sh [base-url]
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
try:
    d=json.load(sys.stdin)
except Exception:
    print(''); sys.exit()
expr=sys.argv[1]
if expr.startswith('['): expr='d'+expr
try:
    print(eval(expr,{'d':d,'len':len,'set':set,'sorted':sorted}))
except Exception:
    print('')" "$1" 2>/dev/null; }

A_JAR="$TMP/a.jar"
B_JAR="$TMP/b.jar"

setup_org() {
  local email="$1" jar="$2" name="$3"
  curl -s -m 15 -c "$jar" -X POST "$BASE/auth/sign-up/email" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"CorrectHorseBattery1\",\"name\":\"Q U\",\"firstName\":\"Q\",\"lastName\":\"U\"}" -o /dev/null
  curl -s -m 15 -c "$jar" -X POST "$BASE/auth/sign-in/email" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"CorrectHorseBattery1\"}" -o /dev/null
  curl -s -m 15 -b "$jar" -c "$jar" -X POST "$BASE/organisations" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\",\"currencyCode\":\"INR\",\"countryCode\":\"IN\"}" | jqp "['data']['id']"
}

new_customer() {
  curl -s -m 10 -b "$1" -X POST "$BASE/customers" -H 'Content-Type: application/json' \
    -d "{\"customerType\":\"COMPANY\",\"companyName\":\"$2\",\"billing\":{\"addressLine1\":\"1 High St\",\"city\":\"Pune\",\"state\":\"Maharashtra\",\"postalCode\":\"411001\",\"countryCode\":\"IN\"}}" | jqp "['data']['id']"
}

# Creates a quotation; echoes its id.
new_quotation() {
  local jar="$1" customer="$2" items="$3"
  curl -s -m 15 -b "$jar" -X POST "$BASE/quotations" -H 'Content-Type: application/json' \
    -d "{\"customerId\":\"$customer\",\"issueDate\":\"2026-08-14\",\"validUntil\":\"2026-09-13\",\"items\":$items}" \
    | jqp "['data']['id']"
}

echo
echo "EPIC 3 — Quotations"
echo

A_ORG=$(setup_org "quo-a-$STAMP@test.local" "$A_JAR" "Quo Org A")
B_ORG=$(setup_org "quo-b-$STAMP@test.local" "$B_JAR" "Quo Org B")
[ -z "$A_ORG" ] && { echo "setup failed"; exit 1; }
A_CUST=$(new_customer "$A_JAR" "Quote Client A")
B_CUST=$(new_customer "$B_JAR" "Quote Client B")
is_uuid() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; }
for pair in "A_ORG:$A_ORG" "B_ORG:$B_ORG" "A_CUST:$A_CUST" "B_CUST:$B_CUST"; do
  if ! is_uuid "${pair#*:}"; then
    echo "  fixture setup failed: ${pair%%:*}='${pair#*:}'"; exit 1
  fi
done
echo "  Org A: $A_ORG (customer $A_CUST)"
echo "  Org B: $B_ORG (customer $B_CUST)"
echo

# --- Creation and server-side calculation -----------------------------------
echo "1. Creation and calculation (TICKET-016, TICKET-017)"

CREATED=$(curl -s -m 15 -b "$A_JAR" -X POST "$BASE/quotations" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$A_CUST\",\"issueDate\":\"2026-08-14\",\"validUntil\":\"2026-09-13\",
       \"items\":[{\"description\":\"Consulting\",\"quantity\":\"10\",\"unitPrice\":\"5000\",\"taxRate\":\"18\"},
                  {\"description\":\"Setup\",\"quantity\":\"1\",\"unitPrice\":\"15000\",\"discountRate\":\"10\",\"taxRate\":\"18\"}]}")
QID=$(printf '%s' "$CREATED" | jqp "['data']['id']")

check "QUO-000001" "$(printf '%s' "$CREATED" | jqp "['data']['quotationNumber']")" "First quotation numbered QUO-000001"
check "DRAFT" "$(printf '%s' "$CREATED" | jqp "['data']['status']")" "Starts as DRAFT"
# 10x5000 = 50000; 15000 less 10% = 13500; subtotal 63500
check "63500" "$(printf '%s' "$CREATED" | jqp "['data']['subtotal']")" "Subtotal computed server-side"
check "11430" "$(printf '%s' "$CREATED" | jqp "['data']['taxAmount']")" "Tax computed server-side"
check "74930" "$(printf '%s' "$CREATED" | jqp "['data']['totalAmount']")" "Total computed server-side"
check "2" "$(printf '%s' "$CREATED" | jqp "len(d['data']['items'])")" "Line items persisted"

# Client-supplied totals must be ignored, not honoured.
TAMPER=$(curl -s -m 15 -b "$A_JAR" -X POST "$BASE/quotations" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$A_CUST\",\"issueDate\":\"2026-08-14\",\"totalAmount\":\"1\",\"subtotal\":\"1\",\"taxAmount\":\"0\",
       \"items\":[{\"description\":\"X\",\"quantity\":\"1\",\"unitPrice\":\"1000\",\"taxRate\":\"18\"}]}")
check "1180" "$(printf '%s' "$TAMPER" | jqp "['data']['totalAmount']")" "Client-supplied totals ignored"

EMPTY_ITEMS=$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/quotations" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$A_CUST\",\"issueDate\":\"2026-08-14\",\"items\":[]}")
check "VALIDATION_ERROR" "$(printf '%s' "$EMPTY_ITEMS" | jqp "['error']['code']")" "Empty item list rejected"


NEG_QTY=$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/quotations" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$A_CUST\",\"issueDate\":\"2026-08-14\",\"items\":[{\"description\":\"X\",\"quantity\":\"-1\",\"unitPrice\":\"10\"}]}")
check "VALIDATION_ERROR" "$(printf '%s' "$NEG_QTY" | jqp "['error']['code']")" "Negative quantity rejected"


BIG_DISC=$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/quotations" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$A_CUST\",\"issueDate\":\"2026-08-14\",\"items\":[{\"description\":\"X\",\"quantity\":\"1\",\"unitPrice\":\"10\",\"discountRate\":\"101\"}]}")
check "VALIDATION_ERROR" "$(printf '%s' "$BIG_DISC" | jqp "['error']['code']")" "Discount over 100% rejected"


BAD_DATES=$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/quotations" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$A_CUST\",\"issueDate\":\"2026-08-14\",\"validUntil\":\"2026-08-01\",\"items\":[{\"description\":\"X\",\"quantity\":\"1\",\"unitPrice\":\"10\"}]}")
check "VALIDATION_ERROR" "$(printf '%s' "$BAD_DATES" | jqp "['error']['code']")" "validUntil before issueDate rejected"


XORG_BODY=$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/quotations" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$B_CUST\",\"issueDate\":\"2026-08-14\",\"items\":[{\"description\":\"X\",\"quantity\":\"1\",\"unitPrice\":\"10\"}]}")
XORG_CODE=$(printf '%s' "$XORG_BODY" | jqp "['error']['code']")
if [ "$XORG_CODE" != "CUSTOMER_NOT_FOUND" ]; then
  printf '        debug body: %s\n' "$XORG_BODY"
fi
check "CUSTOMER_NOT_FOUND" "$XORG_CODE" "Another org's customer rejected"
echo

# --- Numbering ---------------------------------------------------------------
echo "2. Numbering (TICKET-015)"

Q2=$(new_quotation "$A_JAR" "$A_CUST" '[{"description":"Second","quantity":"1","unitPrice":"100"}]')
check "QUO-000003" "$(curl -s -m 10 -b "$A_JAR" "$BASE/quotations/$Q2" | jqp "['data']['quotationNumber']")" \
  "Numbers increment per organisation"

# Org B has its own sequence starting at 1.
BQ=$(new_quotation "$B_JAR" "$B_CUST" '[{"description":"B item","quantity":"1","unitPrice":"50"}]')
check "QUO-000001" "$(curl -s -m 10 -b "$B_JAR" "$BASE/quotations/$BQ" | jqp "['data']['quotationNumber']")" \
  "Each organisation numbers independently"
echo

# --- Draft editing -----------------------------------------------------------
echo "3. Draft editing (TICKET-018)"

EDITED=$(curl -s -m 15 -b "$A_JAR" -X PATCH "$BASE/quotations/$Q2" -H 'Content-Type: application/json' \
  -d '{"items":[{"description":"Revised","quantity":"2","unitPrice":"250","taxRate":"18"}]}')
check "500" "$(printf '%s' "$EDITED" | jqp "['data']['subtotal']")" "Totals recalculate on edit"
check "590" "$(printf '%s' "$EDITED" | jqp "['data']['totalAmount']")" "Tax recalculates on edit"
check "QUO-000003" "$(printf '%s' "$EDITED" | jqp "['data']['quotationNumber']")" "Number unchanged by edit"
check "2" "$(printf '%s' "$EDITED" | jqp "['data']['version']")" "Version incremented"

check "STALE_RECORD" "$(curl -s -m 10 -b "$A_JAR" -X PATCH "$BASE/quotations/$Q2" -H 'Content-Type: application/json' \
  -d '{"notes":"stale","expectedVersion":1}' | jqp "['error']['code']")" "Stale version rejected"
echo

# --- Lifecycle ---------------------------------------------------------------
echo "4. Lifecycle (TICKET-019)"

check "INVALID_STATUS_TRANSITION" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/quotations/$QID/accept" | jqp "['error']['code']")" \
  "DRAFT cannot be accepted directly"
check "INVALID_STATUS_TRANSITION" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/quotations/$QID/convert-to-invoice" \
  -H 'Content-Type: application/json' -d '{}' | jqp "['error']['code']")" "DRAFT cannot be converted"

check "SENT" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/quotations/$QID/send" | jqp "['data']['status']")" "DRAFT -> SENT"
check "INVALID_STATUS_TRANSITION" "$(curl -s -m 10 -b "$A_JAR" -X PATCH "$BASE/quotations/$QID" \
  -H 'Content-Type: application/json' -d '{"notes":"tampered"}' | jqp "['error']['code']")" "SENT cannot be edited"
check "INVALID_STATUS_TRANSITION" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/quotations/$QID/send" | jqp "['error']['code']")" \
  "Cannot send twice"

check "ACCEPTED" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/quotations/$QID/accept" | jqp "['data']['status']")" "SENT -> ACCEPTED"

# A rejected quotation is terminal and must never convert.
REJ=$(new_quotation "$A_JAR" "$A_CUST" '[{"description":"To reject","quantity":"1","unitPrice":"100"}]')
curl -s -m 10 -b "$A_JAR" -X POST "$BASE/quotations/$REJ/send" -o /dev/null
check "REJECTED" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/quotations/$REJ/reject" -H 'Content-Type: application/json' \
  -d '{"reason":"Too expensive"}' | jqp "['data']['status']")" "SENT -> REJECTED"
check "INVALID_STATUS_TRANSITION" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/quotations/$REJ/convert-to-invoice" \
  -H 'Content-Type: application/json' -d '{}' | jqp "['error']['code']")" "REJECTED cannot be converted"
check "INVALID_STATUS_TRANSITION" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/quotations/$REJ/accept" | jqp "['error']['code']")" \
  "REJECTED cannot be accepted (no backward transition)"
echo

# --- Conversion --------------------------------------------------------------
echo "5. Conversion (TICKET-022)"

CONV=$(curl -s -m 20 -b "$A_JAR" -X POST "$BASE/quotations/$QID/convert-to-invoice" \
  -H 'Content-Type: application/json' -d '{}')
INV_NUM=$(printf '%s' "$CONV" | jqp "['data']['invoice']['invoiceNumber']")
check "INV-000001" "$INV_NUM" "Invoice created with its own number"
check "False" "$(printf '%s' "$CONV" | jqp "['data']['alreadyConverted']")" "First conversion is not a replay"
check "74930" "$(printf '%s' "$CONV" | jqp "['data']['invoice']['totalAmount']")" "Totals carried across unchanged"

check "CONVERTED" "$(curl -s -m 10 -b "$A_JAR" "$BASE/quotations/$QID" | jqp "['data']['status']")" "Quotation marked CONVERTED"
check "2" "$(curl -s -m 10 -b "$A_JAR" "$BASE/quotations/$QID" | jqp "len(d['data']['items'])")" "Source quotation items intact"
check "$INV_NUM" "$(curl -s -m 10 -b "$A_JAR" "$BASE/quotations/$QID" | jqp "['data']['invoices'][0]['invoiceNumber']")" \
  "Quotation links to its invoice"

# Idempotency: a repeat returns the same invoice rather than making another.
REPLAY=$(curl -s -m 20 -b "$A_JAR" -X POST "$BASE/quotations/$QID/convert-to-invoice" \
  -H 'Content-Type: application/json' -d '{}')
check "$INV_NUM" "$(printf '%s' "$REPLAY" | jqp "['data']['invoice']['invoiceNumber']")" "Repeat conversion returns the same invoice"
check "True" "$(printf '%s' "$REPLAY" | jqp "['data']['alreadyConverted']")" "Repeat flagged as already converted"

# Concurrent conversion must not produce two invoices.
CONC=$(new_quotation "$A_JAR" "$A_CUST" '[{"description":"Race","quantity":"1","unitPrice":"1000","taxRate":"18"}]')
curl -s -m 10 -b "$A_JAR" -X POST "$BASE/quotations/$CONC/send" -o /dev/null
curl -s -m 10 -b "$A_JAR" -X POST "$BASE/quotations/$CONC/accept" -o /dev/null

for i in $(seq 1 8); do
  curl -s -m 25 -b "$A_JAR" -X POST "$BASE/quotations/$CONC/convert-to-invoice" \
    -H 'Content-Type: application/json' -d '{}' > "$TMP/conv_$i.json" &
done
wait

DISTINCT=$(python3 -c "
import json,glob,sys
nums=set()
for f in glob.glob('$TMP/conv_*.json'):
    try:
        d=json.load(open(f))
        if 'data' in d: nums.add(d['data']['invoice']['invoiceNumber'])
    except Exception: pass
print(len(nums))")
check "1" "$DISTINCT" "8 concurrent conversions produce exactly one invoice"
echo

# --- Duplicate ---------------------------------------------------------------
echo "6. Duplicate (TICKET-021)"

DUP=$(curl -s -m 15 -b "$A_JAR" -X POST "$BASE/quotations/$QID/duplicate")
check "DRAFT" "$(printf '%s' "$DUP" | jqp "['data']['status']")" "Duplicate starts as DRAFT"
check "74930" "$(printf '%s' "$DUP" | jqp "['data']['totalAmount']")" "Duplicate copies totals"
check "2" "$(printf '%s' "$DUP" | jqp "len(d['data']['items'])")" "Duplicate copies line items"
check "None" "$(printf '%s' "$DUP" | jqp "['data']['sentAt']")" "Duplicate clears sentAt"
check "None" "$(printf '%s' "$DUP" | jqp "['data']['convertedAt']")" "Duplicate clears convertedAt"

DUP_NUM=$(printf '%s' "$DUP" | jqp "['data']['quotationNumber']")
if [ "$DUP_NUM" != "QUO-000001" ]; then pass "Duplicate gets a new number ($DUP_NUM)"; else fail "Duplicate gets a new number" "reused QUO-000001"; fi
check "CONVERTED" "$(curl -s -m 10 -b "$A_JAR" "$BASE/quotations/$QID" | jqp "['data']['status']")" "Original unchanged by duplication"
echo

# --- Listing -----------------------------------------------------------------
echo "7. Listing and filters (TICKET-014)"

# Two quotations end up CONVERTED: the main one and the concurrency fixture.
check "2" "$(curl -s -m 10 -b "$A_JAR" "$BASE/quotations?status=CONVERTED" | jqp "['data']['total']")" "Filter by status"
check "1" "$(curl -s -m 10 -b "$A_JAR" "$BASE/quotations?search=QUO-000001" | jqp "['data']['total']")" "Search by number"
check "1" "$(curl -s -m 10 -b "$A_JAR" "$BASE/quotations?status=REJECTED" | jqp "['data']['total']")" "Rejected appear under their status"
check "0" "$(curl -s -m 10 -b "$A_JAR" "$BASE/quotations?dateFrom=2027-01-01" | jqp "['data']['total']")" "Date filter excludes older documents"
echo

# --- Tenant isolation --------------------------------------------------------
echo "8. Tenant isolation"

check "1" "$(curl -s -m 10 -b "$B_JAR" "$BASE/quotations" | jqp "['data']['total']")" "Org B sees only its own quotation"
check "QUOTATION_NOT_FOUND" "$(curl -s -m 10 -b "$B_JAR" "$BASE/quotations/$QID" | jqp "['error']['code']")" \
  "Org B cannot read Org A's quotation by UUID"
check "QUOTATION_NOT_FOUND" "$(curl -s -m 10 -b "$B_JAR" -X POST "$BASE/quotations/$QID/send" | jqp "['error']['code']")" \
  "Org B cannot send Org A's quotation"
check "QUOTATION_NOT_FOUND" "$(curl -s -m 10 -b "$B_JAR" -X POST "$BASE/quotations/$QID/convert-to-invoice" \
  -H 'Content-Type: application/json' -d '{}' | jqp "['error']['code']")" "Org B cannot convert Org A's quotation"
check "QUOTATION_NOT_FOUND" "$(curl -s -m 10 -b "$B_JAR" -X POST "$BASE/quotations/$QID/duplicate" | jqp "['error']['code']")" \
  "Org B cannot duplicate Org A's quotation"
echo

echo "------------------------------------------------------"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
echo "------------------------------------------------------"
echo
[ "$FAIL" -eq 0 ]
