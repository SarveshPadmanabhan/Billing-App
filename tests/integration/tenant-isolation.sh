#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Phase 1 Definition of Done — multi-tenant isolation, end to end over HTTP.
#
# Proves, against a running API and a real database, that organisation B
# cannot reach organisation A's data through any endpoint — including by
# presenting A's exact UUIDs.
#
# Usage: tests/integration/tenant-isolation.sh [base-url]
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

# assert_status <expected> <actual> <description>
assert_status() {
  if [ "$2" = "$1" ]; then pass "$3 (HTTP $2)"; else fail "$3" "expected HTTP $1, got $2"; fi
}

json_field() { printf '%s' "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(eval('d'+sys.argv[1], {'d':d}))" "$2" 2>/dev/null; }

echo
echo "Multi-tenant isolation suite"
echo "Base URL: $BASE"
echo

# --- Fixtures ---------------------------------------------------------------
# Two organisations, each with its own owner, created through the real API.

register_and_login() {
  local email="$1" jar="$2"
  curl -s -m 15 -c "$jar" -X POST "$BASE/auth/sign-up/email" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"CorrectHorseBattery1\",\"name\":\"Test User\",\"firstName\":\"Test\",\"lastName\":\"User\"}" \
    -o /dev/null
  curl -s -m 15 -c "$jar" -X POST "$BASE/auth/sign-in/email" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"CorrectHorseBattery1\"}" -o /dev/null
}

create_org() {
  local jar="$1" name="$2"
  curl -s -m 15 -b "$jar" -c "$jar" -X POST "$BASE/organisations" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\",\"currencyCode\":\"INR\",\"countryCode\":\"IN\"}"
}

create_customer() {
  local jar="$1" name="$2"
  curl -s -m 15 -b "$jar" -X POST "$BASE/customers" \
    -H 'Content-Type: application/json' \
    -d "{\"companyName\":\"$name\",\"billing\":{\"addressLine1\":\"1 High St\",\"city\":\"Pune\",\"state\":\"Maharashtra\",\"postalCode\":\"411001\",\"countryCode\":\"IN\"}}"
}

echo "Setting up two organisations..."
A_JAR="$TMP/a.jar"; B_JAR="$TMP/b.jar"
register_and_login "alpha-$STAMP@isolation.test" "$A_JAR"
register_and_login "bravo-$STAMP@isolation.test" "$B_JAR"

A_ORG_RAW="$(create_org "$A_JAR" "Alpha Industries")"
B_ORG_RAW="$(create_org "$B_JAR" "Bravo Systems")"
A_ORG_ID="$(json_field "$A_ORG_RAW" "['data']['id']")"
B_ORG_ID="$(json_field "$B_ORG_RAW" "['data']['id']")"

A_CUST_RAW="$(create_customer "$A_JAR" "Alpha Secret Customer")"
B_CUST_RAW="$(create_customer "$B_JAR" "Bravo Customer")"
A_CUST_ID="$(json_field "$A_CUST_RAW" "['data']['id']")"
B_CUST_ID="$(json_field "$B_CUST_RAW" "['data']['id']")"

if [ -z "$A_ORG_ID" ] || [ -z "$B_ORG_ID" ] || [ -z "$A_CUST_ID" ]; then
  echo "  Fixture setup failed."
  echo "    A org:  $A_ORG_RAW"
  echo "    B org:  $B_ORG_RAW"
  echo "    A cust: $A_CUST_RAW"
  exit 1
fi

echo "  Org A: $A_ORG_ID (customer $A_CUST_ID)"
echo "  Org B: $B_ORG_ID (customer $B_CUST_ID)"
echo

# --- 1. Baseline: each org sees its own data --------------------------------
echo "1. Baseline visibility"

A_LIST="$(curl -s -m 10 -b "$A_JAR" "$BASE/customers")"
if printf '%s' "$A_LIST" | grep -q "Alpha Secret Customer"; then
  pass "Org A sees its own customer"
else
  fail "Org A sees its own customer" "$A_LIST"
fi

B_LIST="$(curl -s -m 10 -b "$B_JAR" "$BASE/customers")"
if printf '%s' "$B_LIST" | grep -q "Bravo Customer"; then
  pass "Org B sees its own customer"
else
  fail "Org B sees its own customer" "$B_LIST"
fi
echo

# --- 2. Cross-tenant list leakage -------------------------------------------
echo "2. Cross-tenant list isolation"

if printf '%s' "$B_LIST" | grep -q "Alpha Secret Customer"; then
  fail "Org B's list excludes Org A's customer" "LEAK: Alpha data present in B's list"
else
  pass "Org B's list excludes Org A's customer"
fi

B_TOTAL="$(json_field "$B_LIST" "['data']['total']")"
if [ "$B_TOTAL" = "1" ]; then
  pass "Org B's list total counts only its own rows (total=1)"
else
  fail "Org B's list total counts only its own rows" "expected total=1, got $B_TOTAL"
fi
echo

# --- 3. Direct fetch by a known foreign UUID (the DoD case) -----------------
echo "3. Direct fetch by guessed/reused UUID"

CODE="$(curl -s -m 10 -o "$TMP/out" -w '%{http_code}' -b "$B_JAR" "$BASE/customers/$A_CUST_ID")"
assert_status "404" "$CODE" "Org B fetching Org A's customer by exact UUID is refused"

if grep -q "Alpha Secret Customer" "$TMP/out"; then
  fail "Refusal body leaks no Org A data" "LEAK: $(cat "$TMP/out")"
else
  pass "Refusal body leaks no Org A data"
fi

# A 403 would confirm the record exists; the response must be indistinguishable
# from a genuinely absent record.
RANDOM_UUID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
CODE_ABSENT="$(curl -s -m 10 -o "$TMP/absent" -w '%{http_code}' -b "$B_JAR" "$BASE/customers/$RANDOM_UUID")"
if [ "$CODE" = "$CODE_ABSENT" ] && \
   [ "$(json_field "$(cat "$TMP/out")" "['error']['code']")" = "$(json_field "$(cat "$TMP/absent")" "['error']['code']")" ]; then
  pass "Foreign record and non-existent record are indistinguishable (no existence oracle)"
else
  fail "Foreign record and non-existent record are indistinguishable" \
       "foreign=$CODE $(cat "$TMP/out"), absent=$CODE_ABSENT $(cat "$TMP/absent")"
fi
echo

# --- 4. Forged organisation context -----------------------------------------
echo "4. Forged organisation identifiers"

CODE="$(curl -s -m 10 -o "$TMP/out" -w '%{http_code}' -b "$B_JAR" \
  -H "X-Organisation-Id: $A_ORG_ID" "$BASE/customers")"
assert_status "403" "$CODE" "X-Organisation-Id header naming Org A is rejected"

CODE="$(curl -s -m 10 -o "$TMP/out" -w '%{http_code}' -b "$B_JAR" \
  "$BASE/customers?organisationId=$A_ORG_ID")"
assert_status "403" "$CODE" "organisationId query parameter naming Org A is rejected"

CODE="$(curl -s -m 10 -o "$TMP/out" -w '%{http_code}' -b "$B_JAR" -X POST "$BASE/customers" \
  -H 'Content-Type: application/json' \
  -d "{\"companyName\":\"Injected\",\"organisationId\":\"$A_ORG_ID\"}")"
assert_status "403" "$CODE" "organisationId in request body naming Org A is rejected"

# The injected customer must not have been created in EITHER organisation.
A_AFTER="$(curl -s -m 10 -b "$A_JAR" "$BASE/customers")"
if printf '%s' "$A_AFTER" | grep -q "Injected"; then
  fail "Rejected body-injection created nothing in Org A" "LEAK: customer was created"
else
  pass "Rejected body-injection created nothing in Org A"
fi
echo

# --- 5. Organisation switching ----------------------------------------------
echo "5. Organisation switching"

CODE="$(curl -s -m 10 -o "$TMP/out" -w '%{http_code}' -b "$B_JAR" -X POST "$BASE/auth/switch-organisation" \
  -H 'Content-Type: application/json' -d "{\"organisationId\":\"$A_ORG_ID\"}")"
assert_status "404" "$CODE" "Switching into an organisation without membership is refused"

# After the failed switch, B must still be scoped to its own organisation.
B_AFTER="$(curl -s -m 10 -b "$B_JAR" "$BASE/customers")"
if printf '%s' "$B_AFTER" | grep -q "Alpha Secret Customer"; then
  fail "Failed switch did not change B's tenant context" "LEAK: B now sees A's data"
else
  pass "Failed switch did not change B's tenant context"
fi
echo

# --- 6. Organisation endpoints ----------------------------------------------
echo "6. Organisation record isolation"

A_ORG_VIEW="$(curl -s -m 10 -b "$A_JAR" "$BASE/organisations/current")"
if printf '%s' "$A_ORG_VIEW" | grep -q "Alpha Industries"; then
  pass "Org A reads its own organisation record"
else
  fail "Org A reads its own organisation record" "$A_ORG_VIEW"
fi

B_ORG_VIEW="$(curl -s -m 10 -b "$B_JAR" "$BASE/organisations/current")"
if printf '%s' "$B_ORG_VIEW" | grep -q "Alpha Industries"; then
  fail "Org B's organisation record is not Org A's" "LEAK: $B_ORG_VIEW"
else
  pass "Org B's organisation record is not Org A's"
fi
echo

# --- 7. Unauthenticated access ----------------------------------------------
echo "7. Unauthenticated access"

for path in "customers" "customers/$A_CUST_ID" "organisations/current" "auth/me"; do
  CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/$path")"
  assert_status "401" "$CODE" "Anonymous request to /$path is refused"
done
echo

# --- 8. Malformed identifiers -----------------------------------------------
echo "8. Malformed identifiers"

for bad in "not-a-uuid" "../../etc/passwd" "1%20OR%201=1" "00000000-0000-0000-0000-000000000000"; do
  CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -b "$A_JAR" "$BASE/customers/$bad")"
  if [ "$CODE" = "404" ] || [ "$CODE" = "400" ]; then
    pass "Malformed id '$bad' handled safely (HTTP $CODE)"
  else
    fail "Malformed id '$bad' handled safely" "got HTTP $CODE"
  fi
done
echo

# --- Summary ----------------------------------------------------------------
echo "------------------------------------------------------"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
echo "------------------------------------------------------"
echo
[ "$FAIL" -eq 0 ]
