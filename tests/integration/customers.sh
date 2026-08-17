#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# EPIC 2 — Customer management (TICKET-009 … TICKET-013)
#
# Drives the real HTTP API against a real database. Requires the API on :4000
# and a seeded database (pnpm db:seed).
#
# Usage: tests/integration/customers.sh [base-url]
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

# Evaluates a Python expression against the parsed JSON body.
# An expression starting with '[' is treated as a subscript on `d`;
# anything else (e.g. "len(d['data']['items'])") is evaluated as-is.
jqp() { python3 -c "import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    print(''); sys.exit()
expr=sys.argv[1]
if expr.startswith('['):
    expr='d'+expr
try:
    print(eval(expr,{'d':d,'len':len}))
except Exception:
    print('')" "$1" 2>/dev/null; }

A_JAR="$TMP/a.jar"
B_JAR="$TMP/b.jar"

setup_user() {
  local email="$1" jar="$2" org_name="$3"
  curl -s -m 15 -c "$jar" -X POST "$BASE/auth/sign-up/email" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"CorrectHorseBattery1\",\"name\":\"T U\",\"firstName\":\"T\",\"lastName\":\"U\"}" -o /dev/null
  curl -s -m 15 -c "$jar" -X POST "$BASE/auth/sign-in/email" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"CorrectHorseBattery1\"}" -o /dev/null
  curl -s -m 15 -b "$jar" -c "$jar" -X POST "$BASE/organisations" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$org_name\",\"currencyCode\":\"INR\",\"countryCode\":\"IN\"}" | jqp "['data']['id']"
}

echo
echo "EPIC 2 — Customers"
echo "Base URL: $BASE"
echo

echo "Setting up two organisations..."
A_ORG=$(setup_user "cust-a-$STAMP@test.local" "$A_JAR" "Cust Org A")
B_ORG=$(setup_user "cust-b-$STAMP@test.local" "$B_JAR" "Cust Org B")
[ -z "$A_ORG" ] && { echo "  setup failed"; exit 1; }
echo "  A: $A_ORG   B: $B_ORG"
echo

# --- TICKET-010 create -------------------------------------------------------
echo "1. Create (TICKET-010)"

CREATED=$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/customers" -H 'Content-Type: application/json' \
  -d '{"customerType":"COMPANY","companyName":"Alpha Client","email":"ap@alpha.test","billing":{"addressLine1":"1 High St","city":"Pune","state":"Maharashtra","postalCode":"411001","countryCode":"IN"},"shippingSameAsBilling":true}')
CUST_ID=$(printf '%s' "$CREATED" | jqp "['data']['id']")
[ -n "$CUST_ID" ] && pass "Company customer created" || fail "Company customer created" "$CREATED"

check "1 High St" "$(printf '%s' "$CREATED" | jqp "['data']['shippingAddressLine1']")" \
  "shippingSameAsBilling copied server-side"

check "COMPANY" "$(printf '%s' "$CREATED" | jqp "['data']['customerType']")" "customerType stored"

IND=$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/customers" -H 'Content-Type: application/json' \
  -d '{"customerType":"INDIVIDUAL","contactName":"Ravi Kumar","phone":"+91 90000 00000","billing":{"addressLine1":"1 High St","city":"Pune","state":"Maharashtra","postalCode":"411001","countryCode":"IN"}}')
[ -n "$(printf '%s' "$IND" | jqp "['data']['id']")" ] && pass "Individual customer created" \
  || fail "Individual customer created" "$IND"

check "VALIDATION_ERROR" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/customers" \
  -H 'Content-Type: application/json' -d '{"customerType":"COMPANY","contactName":"X"}' \
  | jqp "['error']['code']")" "COMPANY without companyName rejected"

check "VALIDATION_ERROR" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/customers" \
  -H 'Content-Type: application/json' -d '{"customerType":"INDIVIDUAL","companyName":"X"}' \
  | jqp "['error']['code']")" "INDIVIDUAL without contactName rejected"

check "VALIDATION_ERROR" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/customers" \
  -H 'Content-Type: application/json' -d '{"customerType":"COMPANY","companyName":"X","email":"bad"}' \
  | jqp "['error']['code']")" "Invalid email rejected"

# Unicode and long names (Security Doc §27).
UNI=$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/customers" -H 'Content-Type: application/json' \
  -d '{"customerType":"COMPANY","companyName":"Ünïcode Ltd 株式会社 🏢","billing":{"addressLine1":"1 High St","city":"Pune","state":"Maharashtra","postalCode":"411001","countryCode":"IN"}}')
[ -n "$(printf '%s' "$UNI" | jqp "['data']['id']")" ] && pass "Unicode company name accepted" \
  || fail "Unicode company name accepted" "$UNI"

LONG=$(python3 -c "print('X'*300)")
check "VALIDATION_ERROR" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/customers" \
  -H 'Content-Type: application/json' -d "{\"customerType\":\"COMPANY\",\"companyName\":\"$LONG\"}" \
  | jqp "['error']['code']")" "Over-long company name rejected (not persisted)"
echo

# --- TICKET-012 search -------------------------------------------------------
echo "2. Search (TICKET-012)"

check "1" "$(curl -s -m 10 -b "$A_JAR" "$BASE/customers?search=Alph" | jqp "['data']['total']")" \
  "Partial name match"
check "1" "$(curl -s -m 10 -b "$A_JAR" "$BASE/customers?search=alpha.test" | jqp "['data']['total']")" \
  "Email match"
check "1" "$(curl -s -m 10 -b "$A_JAR" "$BASE/customers?search=90000" | jqp "['data']['total']")" \
  "Phone match"
check "1" "$(curl -s -m 10 -b "$A_JAR" "$BASE/customers?search=ALPH" | jqp "['data']['total']")" \
  "Search is case-insensitive"
check "0" "$(curl -s -m 10 -b "$A_JAR" "$BASE/customers?search=zzzznotfound" | jqp "['data']['total']")" \
  "No match returns empty"
# Alpha Client + Ravi Kumar + Ünïcode Ltd = 3 successful creates.
check "3" "$(curl -s -m 10 -b "$A_JAR" "$BASE/customers" | jqp "['data']['total']")" \
  "Empty search restores full list"

# A quoted SQL metacharacter must be treated as a literal, not executed.
check "0" "$(curl -s -m 10 -b "$A_JAR" "$BASE/customers?search=%27%20OR%20%271%27%3D%271" | jqp "['data']['total']")" \
  "SQL metacharacters treated as literal text"
echo

# --- TICKET-009 list ---------------------------------------------------------
echo "3. List and pagination (TICKET-009)"

check "2" "$(curl -s -m 10 -b "$A_JAR" "$BASE/customers?page=1&limit=2" | jqp "len(d['data']['items'])")" \
  "limit honoured"
check "2" "$(curl -s -m 10 -b "$A_JAR" "$BASE/customers?page=1&limit=2" | jqp "['data']['totalPages']")" \
  "totalPages computed"
check "VALIDATION_ERROR" "$(curl -s -m 10 -b "$A_JAR" "$BASE/customers?limit=5000" | jqp "['error']['code']")" \
  "Excessive limit rejected (Security Doc §33)"
check "0.0000" "$(curl -s -m 10 -b "$A_JAR" "$BASE/customers?search=Alph" | jqp "['data']['items'][0]['outstanding']")" \
  "outstanding present on list rows"
echo

# --- TICKET-011 archive ------------------------------------------------------
echo "4. Archive and restore (TICKET-011)"

check "VALIDATION_ERROR" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/customers/$CUST_ID/archive" \
  -H 'Content-Type: application/json' -d '{}' | jqp "['error']['code']")" \
  "Archive requires explicit confirmation"

check "True" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/customers/$CUST_ID/archive" \
  -H 'Content-Type: application/json' -d '{"confirm":true,"reason":"test"}' \
  | jqp "['data']['isArchived']")" "Archive with confirm succeeds"

check "2" "$(curl -s -m 10 -b "$A_JAR" "$BASE/customers" | jqp "['data']['total']")" \
  "Archived customer leaves the default list"
check "1" "$(curl -s -m 10 -b "$A_JAR" "$BASE/customers?status=archived" | jqp "['data']['total']")" \
  "Archived customer visible under status=archived"
check "3" "$(curl -s -m 10 -b "$A_JAR" "$BASE/customers?status=all" | jqp "['data']['total']")" \
  "status=all shows both"

check "INVALID_STATUS_TRANSITION" "$(curl -s -m 10 -b "$A_JAR" -X PATCH "$BASE/customers/$CUST_ID" \
  -H 'Content-Type: application/json' -d '{"phone":"1"}' | jqp "['error']['code']")" \
  "Archived customer cannot be edited"

check "INVALID_STATUS_TRANSITION" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/customers/$CUST_ID/archive" \
  -H 'Content-Type: application/json' -d '{"confirm":true}' | jqp "['error']['code']")" \
  "Double archive rejected"

check "False" "$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/customers/$CUST_ID/restore" \
  | jqp "['data']['isArchived']")" "Restore works"

# There must be no delete route at all.
DELETE_CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -b "$A_JAR" -X DELETE "$BASE/customers/$CUST_ID")
if [ "$DELETE_CODE" = "404" ] || [ "$DELETE_CODE" = "405" ]; then
  pass "No DELETE endpoint exists (HTTP $DELETE_CODE)"
else
  fail "No DELETE endpoint exists" "got HTTP $DELETE_CODE"
fi
echo

# --- Optimistic concurrency --------------------------------------------------
echo "5. Concurrent editing (Security Doc §24)"

check "STALE_RECORD" "$(curl -s -m 10 -b "$A_JAR" -X PATCH "$BASE/customers/$CUST_ID" \
  -H 'Content-Type: application/json' \
  -d '{"phone":"111","expectedUpdatedAt":"2020-01-01T00:00:00.000Z"}' | jqp "['error']['code']")" \
  "Stale write rejected"

# Capture into a variable first: inlining this in $(...) with escaped inner
# quotes mangles the surrounding argument parsing.
FRESH=$(curl -s -m 10 -b "$A_JAR" "$BASE/customers/$CUST_ID" | jqp "['data']['updatedAt']")
FRESH_BODY=$(curl -s -m 10 -b "$A_JAR" -X PATCH "$BASE/customers/$CUST_ID" \
  -H 'Content-Type: application/json' \
  -d "{\"phone\":\"222\",\"expectedUpdatedAt\":\"${FRESH}\"}")
FRESH_PHONE=$(printf '%s' "$FRESH_BODY" | jqp "['data']['phone']")
check "222" "$FRESH_PHONE" "Fresh write accepted"
echo

# --- TICKET-013 billing history ---------------------------------------------
echo "6. Billing history (TICKET-013)"

HIST=$(curl -s -m 10 -b "$A_JAR" "$BASE/customers/$CUST_ID/billing-history")
check "0.0000" "$(printf '%s' "$HIST" | jqp "['data']['totals']['totalInvoiced']")" "totalInvoiced present"
check "0.0000" "$(printf '%s' "$HIST" | jqp "['data']['totals']['outstanding']")" "outstanding present"
check "0" "$(printf '%s' "$HIST" | jqp "len(d['data']['invoices'])")" "invoice list present"
echo

# --- Tenant isolation --------------------------------------------------------
echo "7. Tenant isolation"

check "0" "$(curl -s -m 10 -b "$B_JAR" "$BASE/customers" | jqp "['data']['total']")" \
  "Org B sees none of Org A's customers"
check "CUSTOMER_NOT_FOUND" "$(curl -s -m 10 -b "$B_JAR" "$BASE/customers/$CUST_ID" | jqp "['error']['code']")" \
  "Org B cannot fetch Org A's customer by UUID"
check "CUSTOMER_NOT_FOUND" "$(curl -s -m 10 -b "$B_JAR" "$BASE/customers/$CUST_ID/billing-history" | jqp "['error']['code']")" \
  "Org B cannot read Org A's billing history"
check "CUSTOMER_NOT_FOUND" "$(curl -s -m 10 -b "$B_JAR" -X PATCH "$BASE/customers/$CUST_ID" \
  -H 'Content-Type: application/json' -d '{"phone":"666"}' | jqp "['error']['code']")" \
  "Org B cannot edit Org A's customer"
check "CUSTOMER_NOT_FOUND" "$(curl -s -m 10 -b "$B_JAR" -X POST "$BASE/customers/$CUST_ID/archive" \
  -H 'Content-Type: application/json' -d '{"confirm":true}' | jqp "['error']['code']")" \
  "Org B cannot archive Org A's customer"

# Confirm the failed cross-tenant edit changed nothing.
check "222" "$(curl -s -m 10 -b "$A_JAR" "$BASE/customers/$CUST_ID" | jqp "['data']['phone']")" \
  "Org A's record unchanged after B's attempts"
echo

echo "------------------------------------------------------"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
echo "------------------------------------------------------"
echo
[ "$FAIL" -eq 0 ]
