#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# EPIC 6 — Global search and document filters (TICKET-036, TICKET-037)
#
# Requires the API on :4000 and a seeded database.
# Usage: tests/integration/search.sh [base-url]
# ---------------------------------------------------------------------------
set -uo pipefail

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
try: print(eval(expr,{'d':d,'len':len,'sorted':sorted,'set':set}))
except Exception: print('')" "$1" 2>/dev/null; }

is_uuid() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; }

A_JAR="$TMP/a.jar"
B_JAR="$TMP/b.jar"

setup_org() {
  local email="$1" jar="$2" name="$3"
  curl -s -m 15 -c "$jar" -X POST "$BASE/auth/sign-up/email" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"CorrectHorseBattery1\",\"name\":\"S U\",\"firstName\":\"S\",\"lastName\":\"U\"}" -o /dev/null
  curl -s -m 15 -c "$jar" -X POST "$BASE/auth/sign-in/email" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"CorrectHorseBattery1\"}" -o /dev/null
  curl -s -m 15 -b "$jar" -c "$jar" -X POST "$BASE/organisations" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\",\"currencyCode\":\"INR\",\"countryCode\":\"IN\"}" | jqp "['data']['id']"
}

echo
echo "EPIC 6 — Search and filters"
echo

A_ORG=$(setup_org "srch-a-$STAMP@test.local" "$A_JAR" "Search Org A")
B_ORG=$(setup_org "srch-b-$STAMP@test.local" "$B_JAR" "Search Org B")

# Distinctive fixture names so matches are unambiguous.
CUST_ZEP=$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/customers" -H 'Content-Type: application/json' \
  -d '{"customerType":"COMPANY","companyName":"Zephyr Dynamics","email":"ap@zephyr.test","billing":{"addressLine1":"1 High St","city":"Pune","state":"Maharashtra","postalCode":"411001","countryCode":"IN"}}' | jqp "['data']['id']")
CUST_ORB=$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/customers" -H 'Content-Type: application/json' \
  -d '{"customerType":"COMPANY","companyName":"Orbital Freight","email":"ap@orbital.test","billing":{"addressLine1":"1 High St","city":"Pune","state":"Maharashtra","postalCode":"411001","countryCode":"IN"}}' | jqp "['data']['id']")
B_CUST=$(curl -s -m 10 -b "$B_JAR" -X POST "$BASE/customers" -H 'Content-Type: application/json' \
  -d '{"customerType":"COMPANY","companyName":"Zephyr Rival Ltd","billing":{"addressLine1":"1 High St","city":"Pune","state":"Maharashtra","postalCode":"411001","countryCode":"IN"}}' | jqp "['data']['id']")

for pair in "A_ORG:$A_ORG" "B_ORG:$B_ORG" "CUST_ZEP:$CUST_ZEP" "CUST_ORB:$CUST_ORB" "B_CUST:$B_CUST"; do
  is_uuid "${pair#*:}" || { echo "  fixture setup failed: ${pair%%:*}='${pair#*:}'"; exit 1; }
done

# Documents spread across dates and customers so filters have something to bite on.
QUOTE_ZEP=$(curl -s -m 15 -b "$A_JAR" -X POST "$BASE/quotations" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$CUST_ZEP\",\"issueDate\":\"2026-03-10\",
       \"items\":[{\"description\":\"Design sprint\",\"quantity\":\"1\",\"unitPrice\":\"90000\",\"taxRate\":\"18\"}]}" \
  | jqp "['data']['id']")
INV_ZEP=$(curl -s -m 15 -b "$A_JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$CUST_ZEP\",\"issueDate\":\"2026-03-15\",\"dueDate\":\"2026-04-14\",
       \"items\":[{\"description\":\"Build phase\",\"quantity\":\"1\",\"unitPrice\":\"250000\",\"taxRate\":\"18\"}]}" \
  | jqp "['data']['id']")
INV_ORB=$(curl -s -m 15 -b "$A_JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$CUST_ORB\",\"issueDate\":\"2026-07-01\",\"dueDate\":\"2026-07-31\",
       \"items\":[{\"description\":\"Logistics retainer\",\"quantity\":\"1\",\"unitPrice\":\"60000\",\"taxRate\":\"18\"}]}" \
  | jqp "['data']['id']")
curl -s -m 60 -b "$A_JAR" -X POST "$BASE/invoices/$INV_ORB/send" -o /dev/null
echo "  fixtures ready"
echo

# --- TICKET-036 global search --------------------------------------------------
echo "1. Global search (TICKET-036)"

ZEP=$(curl -s -m 15 -b "$A_JAR" "$BASE/search?q=Zephyr")
check "1" "$(printf '%s' "$ZEP" | jqp "['data']['counts']['customers']")" "Finds the customer by name"
check "1" "$(printf '%s' "$ZEP" | jqp "['data']['counts']['quotations']")" "Finds that customer's quotation"
check "1" "$(printf '%s' "$ZEP" | jqp "['data']['counts']['invoices']")" "Finds that customer's invoice"
check "3" "$(printf '%s' "$ZEP" | jqp "len(d['data']['results'])")" "Returns all three types in one response"

# Invoices lead the list: looking up a document number is the common case.
check "invoice" "$(printf '%s' "$ZEP" | jqp "['data']['results'][0]['type']")" "Invoices are ordered first"

# Partial matching, case-insensitive.
check "1" "$(curl -s -m 15 -b "$A_JAR" "$BASE/search?q=zeph" | jqp "['data']['counts']['customers']")" \
  "Partial, lower-case match works"
check "1" "$(curl -s -m 15 -b "$A_JAR" "$BASE/search?q=ORBITAL" | jqp "['data']['counts']['customers']")" \
  "Upper-case match works"

# By document number.
INV_NUM=$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices/$INV_ZEP" | jqp "['data']['invoiceNumber']")
NUMHIT=$(curl -s -m 15 -b "$A_JAR" "$BASE/search?q=$INV_NUM")
check "1" "$(printf '%s' "$NUMHIT" | jqp "['data']['counts']['invoices']")" "Finds an invoice by its number"
check "$INV_NUM" "$(printf '%s' "$NUMHIT" | jqp "['data']['results'][0]['title']")" "Result title is the document number"

# Empty and no-match behaviour.
check "0" "$(curl -s -m 15 -b "$A_JAR" "$BASE/search?q=" | jqp "len(d['data']['results'])")" \
  "Empty query returns nothing rather than everything"
check "0" "$(curl -s -m 15 -b "$A_JAR" "$BASE/search?q=zzzznothinghere" | jqp "len(d['data']['results'])")" \
  "No match returns an empty list"

# A result must carry enough to navigate and to recognise.
check "/invoices/$INV_ZEP" "$(printf '%s' "$NUMHIT" | jqp "['data']['results'][0]['url']")" \
  "Result carries a navigable URL"
echo

# --- Search isolation ------------------------------------------------------------
echo "2. Search is organisation-scoped"

B_SEARCH=$(curl -s -m 15 -b "$B_JAR" "$BASE/search?q=Zephyr")
# Org B has its own "Zephyr Rival Ltd" — it must see that and nothing of A's.
check "1" "$(printf '%s' "$B_SEARCH" | jqp "['data']['counts']['customers']")" "Org B sees only its own matching customer"
check "0" "$(printf '%s' "$B_SEARCH" | jqp "['data']['counts']['invoices']")" "Org B sees none of Org A's invoices"
check "0" "$(printf '%s' "$B_SEARCH" | jqp "['data']['counts']['quotations']")" "Org B sees none of Org A's quotations"

if printf '%s' "$B_SEARCH" | grep -q "Zephyr Dynamics"; then
  fail "Org B's results contain no Org A data" "LEAK: found 'Zephyr Dynamics'"
else
  pass "Org B's results contain no Org A data"
fi

check "401" "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/search?q=Zephyr")" \
  "Anonymous search is refused"
echo

# --- Permission-aware results -------------------------------------------------------
echo "3. Search respects role permissions"

# VIEWER may read everything, so all three types should appear.
V_JAR="$TMP/viewer.jar"
curl -s -m 15 -c "$V_JAR" -X POST "$BASE/auth/sign-in/email" -H 'Content-Type: application/json' \
  -d '{"email":"viewer@acme.test","password":"DevPassword123!"}' -o /dev/null
curl -s -m 10 -b "$V_JAR" -c "$V_JAR" -X POST "$BASE/auth/switch-organisation" \
  -H 'Content-Type: application/json' -d '{"organisationId":"11111111-1111-1111-1111-111111111111"}' -o /dev/null

V_SEARCH=$(curl -s -m 15 -b "$V_JAR" "$BASE/search?q=Northwind")
if [ "$(printf '%s' "$V_SEARCH" | jqp "['data']['counts']['customers']")" -ge 1 ] 2>/dev/null; then
  pass "VIEWER can search customers they may view"
else
  fail "VIEWER can search customers they may view" "$V_SEARCH"
fi
if [ "$(printf '%s' "$V_SEARCH" | jqp "['data']['counts']['invoices']")" -ge 1 ] 2>/dev/null; then
  pass "VIEWER sees invoices, which their role may view"
else
  fail "VIEWER sees invoices" "$V_SEARCH"
fi
echo

# --- TICKET-037 combined filters ------------------------------------------------------
echo "4. Combined document filters (TICKET-037)"

check "2" "$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices" | jqp "['data']['total']")" "Unfiltered list shows both invoices"

# Single filters.
check "1" "$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices?status=DRAFT" | jqp "['data']['total']")" "Filter by status"
check "1" "$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices?customerId=$CUST_ORB" | jqp "['data']['total']")" "Filter by customer"
check "1" "$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices?dateFrom=2026-06-01" | jqp "['data']['total']")" "Filter by start date"
check "1" "$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices?dateTo=2026-04-01" | jqp "['data']['total']")" "Filter by end date"

# Combined — the point of the ticket.
check "1" "$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices?status=SENT&customerId=$CUST_ORB&dateFrom=2026-06-01&dateTo=2026-08-01" \
  | jqp "['data']['total']")" "Status + customer + date range combine"

# A combination that matches nothing must return nothing, not fall back.
check "0" "$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices?status=DRAFT&customerId=$CUST_ORB" | jqp "['data']['total']")" \
  "Contradictory filters return an empty list"

# Date range that excludes everything.
check "0" "$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices?dateFrom=2030-01-01" | jqp "['data']['total']")" \
  "Out-of-range dates exclude everything"

# Reversed range: from after to. Must be empty, not an error.
REVERSED=$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices?dateFrom=2026-08-01&dateTo=2026-01-01")
check "0" "$(printf '%s' "$REVERSED" | jqp "['data']['total']")" "Reversed date range returns empty, not an error"

# Search combines with filters too.
check "1" "$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices?search=Zephyr&status=DRAFT" | jqp "['data']['total']")" \
  "Search combines with a status filter"

# Clearing filters restores the full list.
check "2" "$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices" | jqp "['data']['total']")" "Clearing filters restores the list"
echo

# --- Filters on quotations ---------------------------------------------------------------
echo "5. The same filters apply to quotations"

check "1" "$(curl -s -m 10 -b "$A_JAR" "$BASE/quotations?customerId=$CUST_ZEP" | jqp "['data']['total']")" \
  "Quotation filter by customer"
check "1" "$(curl -s -m 10 -b "$A_JAR" "$BASE/quotations?status=DRAFT&dateFrom=2026-01-01&dateTo=2026-12-31" \
  | jqp "['data']['total']")" "Quotation status + date range combine"
# PAID is an invoice status, not a quotation one. The API must reject it
# rather than silently ignoring the filter and returning everything — a
# silently-dropped filter would show more records than the user asked for.
check "VALIDATION_ERROR" "$(curl -s -m 10 -b "$A_JAR" "$BASE/quotations?status=PAID" | jqp "['error']['code']")" \
  "A status that does not exist for quotations is rejected"
echo

# --- Filters remain organisation-scoped -----------------------------------------------------
echo "6. Filters cannot cross tenants"

check "0" "$(curl -s -m 10 -b "$B_JAR" "$BASE/invoices?customerId=$CUST_ZEP" | jqp "['data']['total']")" \
  "Filtering by another org's customer id returns nothing"
check "0" "$(curl -s -m 10 -b "$B_JAR" "$BASE/invoices?search=Zephyr%20Dynamics" | jqp "['data']['total']")" \
  "Searching for another org's customer returns nothing"
echo

echo "------------------------------------------------------"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
echo "------------------------------------------------------"
echo
[ "$FAIL" -eq 0 ]
