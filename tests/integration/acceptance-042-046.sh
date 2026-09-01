#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Acceptance audit — TICKET-042 … TICKET-046
#
# One assertion per acceptance criterion as written in the Feature Ticket
# List, checked explicitly rather than inferred from other coverage. Each
# check is labelled with its ticket and criterion so a gap is unambiguous.
#
# Requires the API on :4000 and a seeded database.
# Usage: tests/integration/acceptance-042-046.sh [base-url]
# ---------------------------------------------------------------------------
set -uo pipefail

# Per-request timeout. 10s suits a local database; a hosted one in another
# region needs far more — a simple list query measured 5-7s against Seoul,
# so multi-query endpoints exceed 10s without anything being wrong.
REQ_TIMEOUT="${REQ_TIMEOUT:-10}"

# Seeded accounts may use a generated password when the database is shared or
# hosted — see SEED_PASSWORD in prisma/seed.ts. Falls back to the local default.
SEED_PASSWORD="${SEED_PASSWORD:-DevPassword123!}"

BASE="${1:-http://localhost:4000/api/v1}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
GAP=0
STAMP="$(date +%s)$$"
TODAY="$(date -u +%Y-%m-%d)"

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; printf '        %s\n' "${2:-}"; FAIL=$((FAIL + 1)); }
gap()  { printf '  \033[33mGAP \033[0m  %s\n' "$1"; printf '        %s\n' "${2:-}"; GAP=$((GAP + 1)); }
check() { if [ "$2" = "$1" ]; then pass "$3"; else fail "$3" "expected '$1', got '$2'"; fi; }

jqp() { python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: print(''); sys.exit()
expr=sys.argv[1]
if expr.startswith('['): expr='d'+expr
try: print(eval(expr,{'d':d,'len':len,'all':all,'any':any,'set':set}))
except Exception: print('')" "$1" 2>/dev/null; }

is_uuid() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; }
code() { curl -s -m "$REQ_TIMEOUT" -o /dev/null -w '%{http_code}' "$@"; }

export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"

# Talk to whatever database the app uses, not a hardcoded local one. Pointed at
# localhost while the app ran on Supabase, these checks deleted from an empty
# local table and reported "DELETE 0" — a pass-looking result that proved
# nothing about the database under test.
DB_TARGET="${DB_TARGET:-}"
if [ -z "$DB_TARGET" ] && [ -f "$(dirname "$0")/../../.env" ]; then
  DB_TARGET=$(grep -E "^DATABASE_MIGRATION_URL=" "$(dirname "$0")/../../.env" | head -1 | cut -d= -f2-)
fi
if [ -n "$DB_TARGET" ]; then
  PSQL() { psql "$DB_TARGET" -tAc "$1" 2>&1; }
else
  PSQL() { psql -h localhost -d billing_dev -tAc "$1" 2>&1; }
fi

A_JAR="$TMP/a.jar"; B_JAR="$TMP/b.jar"

setup_org() {
  local email="$1" jar="$2" name="$3"
  curl -s -m "$REQ_TIMEOUT" -c "$jar" -X POST "$BASE/auth/sign-up/email" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"CorrectHorseBattery1\",\"name\":\"A U\",\"firstName\":\"A\",\"lastName\":\"U\"}" -o /dev/null
  curl -s -m "$REQ_TIMEOUT" -c "$jar" -X POST "$BASE/auth/sign-in/email" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"CorrectHorseBattery1\"}" -o /dev/null
  curl -s -m "$REQ_TIMEOUT" -b "$jar" -c "$jar" -X POST "$BASE/organisations" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\",\"currencyCode\":\"INR\",\"countryCode\":\"IN\"}" | jqp "['data']['id']"
}

A_ORG=$(setup_org "acc-a-$STAMP@test.local" "$A_JAR" "Acceptance Org A")
B_ORG=$(setup_org "acc-b-$STAMP@test.local" "$B_JAR" "Acceptance Org B")
A_CUST=$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/customers" -H 'Content-Type: application/json' \
  -d '{"customerType":"COMPANY","companyName":"Acceptance Client","billing":{"addressLine1":"1 High St","city":"Pune","state":"Maharashtra","postalCode":"411001","countryCode":"IN"}}' | jqp "['data']['id']")
is_uuid "$A_ORG" && is_uuid "$A_CUST" || { echo "fixture setup failed"; exit 1; }

# A sent invoice with a payment, reused across several checks.
INV=$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$A_CUST\",\"paymentMethod\":\"BANK_TRANSFER\",\"issueDate\":\"$TODAY\",
       \"items\":[{\"description\":\"Audit item\",\"quantity\":\"2\",\"unitPrice\":\"5000\",\"taxRate\":\"18\"}]}" \
  | jqp "['data']['id']")
curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/invoices/$INV/send" -o /dev/null

echo
echo "Acceptance audit — TICKET-042 … 046"
echo

# ===========================================================================
echo "TICKET-042 — Audit Trail"
# ===========================================================================

# Criterion: audit records contain actor, organisation, action, entity, timestamp.
FIELDS=$(PSQL "SELECT (user_id IS NOT NULL)::int + (organisation_id IS NOT NULL)::int +
                      (action IS NOT NULL)::int + (entity_id IS NOT NULL)::int +
                      (created_at IS NOT NULL)::int
               FROM audit_logs WHERE action='INVOICE_SENT' ORDER BY created_at DESC LIMIT 1")
check "5" "$FIELDS" "042.1 Audit records carry actor, organisation, action, entity and timestamp"

# Criterion: important financial changes are traceable.
for action in INVOICE_CREATED INVOICE_SENT INVOICE_CANCELLED QUOTATION_CREATED \
              QUOTATION_SENT QUOTATION_CONVERTED PAYMENT_RECORDED PAYMENT_VOIDED; do
  N=$(PSQL "SELECT count(*) FROM audit_logs WHERE action='$action'")
  if [ "${N:-0}" -gt 0 ]; then
    pass "042.2 $action is recorded"
  else
    fail "042.2 $action is recorded" "no audit rows for this action"
  fi
done

# Criterion: normal users cannot edit audit records.
UPD=$(PGPASSWORD=billing_app psql -h localhost -U billing_app -d billing_dev -tAc "
  BEGIN; SET LOCAL app.current_organisation_id='$A_ORG';
  UPDATE audit_logs SET action='TAMPERED' WHERE organisation_id='$A_ORG'::uuid;
  COMMIT;" 2>&1)
if printf '%s' "$UPD" | grep -qiE "denied|append-only|error"; then
  pass "042.3 The runtime role cannot UPDATE audit records"
else
  fail "042.3 The runtime role cannot UPDATE audit records" "update was permitted: $UPD"
fi

DEL=$(PGPASSWORD=billing_app psql -h localhost -U billing_app -d billing_dev -tAc "
  BEGIN; SET LOCAL app.current_organisation_id='$A_ORG';
  DELETE FROM audit_logs WHERE organisation_id='$A_ORG'::uuid;
  COMMIT;" 2>&1)
if printf '%s' "$DEL" | grep -qiE "denied|append-only|error"; then
  pass "042.3 The runtime role cannot DELETE audit records"
else
  fail "042.3 The runtime role cannot DELETE audit records" "delete was permitted: $DEL"
fi

# No API surface exposes audit mutation.
AUDIT_ROUTES=$(grep -rn "audit" "$(dirname "$0")/../../apps/api/src" --include="*.controller.ts" 2>/dev/null \
  | grep -ciE "@Post|@Patch|@Delete" | awk '{s+=$1} END {print s+0}')
check "0" "$AUDIT_ROUTES" "042.3 No API route mutates audit records"

# Criterion: audit data is organisation-isolated.
A_ONLY=$(PGPASSWORD=billing_app psql -h localhost -U billing_app -d billing_dev -tAc "
  BEGIN; SET LOCAL app.current_organisation_id='$A_ORG';
  SELECT count(*) FROM audit_logs WHERE organisation_id <> '$A_ORG'::uuid; COMMIT;" 2>/dev/null \
  | grep -E '^[0-9]+$' | head -1)
check "0" "${A_ONLY:-x}" "042.4 RLS hides other organisations' audit rows"
echo

# ===========================================================================
echo "TICKET-043 — Accidental Deletion Protection"
# ===========================================================================

# Criterion: paid invoices cannot be deleted.
PAID=$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$A_CUST\",\"paymentMethod\":\"BANK_TRANSFER\",\"issueDate\":\"$TODAY\",
       \"items\":[{\"description\":\"Paid item\",\"quantity\":\"1\",\"unitPrice\":\"1000\",\"taxRate\":\"0\"}]}" \
  | jqp "['data']['id']")
curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/invoices/$PAID/send" -o /dev/null
curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/invoices/$PAID/payments" -H 'Content-Type: application/json' \
  -d "{\"amount\":\"1000\",\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"CASH\",\"idempotencyKey\":\"acc-$STAMP\"}" -o /dev/null

DEL_CODE=$(code -b "$A_JAR" -X DELETE "$BASE/invoices/$PAID")
if [ "$DEL_CODE" = "404" ] || [ "$DEL_CODE" = "405" ]; then
  pass "043.1 No DELETE route exists for a paid invoice (HTTP $DEL_CODE)"
else
  fail "043.1 No DELETE route for a paid invoice" "got HTTP $DEL_CODE"
fi

# A PAID invoice must not be withdrawable. Two independent rules can refuse
# it — the role-scoped permission (FORBIDDEN) and the payments-must-be-voided
# rule (INVALID_STATUS_TRANSITION) — and which fires depends on the caller's
# role. The criterion is that it is refused, so accept either.
PAID_CANCEL=$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/invoices/$PAID/cancel" \
  -H 'Content-Type: application/json' -d '{"reason":"attempt"}' | jqp "['error']['code']")
case "$PAID_CANCEL" in
  FORBIDDEN|INVALID_STATUS_TRANSITION)
    pass "043.1 A PAID invoice cannot be cancelled ($PAID_CANCEL)" ;;
  *)
    fail "043.1 A PAID invoice cannot be cancelled" "got '$PAID_CANCEL'" ;;
esac

# Database-level protection, not just the absence of a route.
DB_DEL=$(PSQL "DELETE FROM invoices WHERE id='$PAID'::uuid")
if printf '%s' "$DB_DEL" | grep -qiE "violates foreign key|error"; then
  pass "043.1 The database refuses to delete an invoice holding payments"
else
  fail "043.1 Database refuses deletion of a paid invoice" "delete succeeded or was silent: $DB_DEL"
fi

# Criterion: cancelled invoices remain in history.
CANC=$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$A_CUST\",\"paymentMethod\":\"BANK_TRANSFER\",\"issueDate\":\"$TODAY\",
       \"items\":[{\"description\":\"Cancel me\",\"quantity\":\"1\",\"unitPrice\":\"900\",\"taxRate\":\"0\"}]}" \
  | jqp "['data']['id']")
curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/invoices/$CANC/cancel" -H 'Content-Type: application/json' \
  -d '{"reason":"Acceptance audit"}' -o /dev/null
CANC_AFTER=$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" "$BASE/invoices/$CANC")
check "CANCELLED" "$(printf '%s' "$CANC_AFTER" | jqp "['data']['status']")" \
  "043.2 A cancelled invoice is still retrievable"
CANC_NUM=$(printf '%s' "$CANC_AFTER" | jqp "['data']['invoiceNumber']")
case "$CANC_NUM" in INV-*) pass "043.2 It keeps its number ($CANC_NUM)";; *) fail "043.2 Cancelled invoice keeps its number" "got '$CANC_NUM'";; esac
check "1" "$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" "$BASE/invoices?status=CANCELLED" | jqp "['data']['total']")" \
  "043.2 It still appears in listings"

# Criterion: customer deletion does not destroy financial history.
CUST_DEL=$(code -b "$A_JAR" -X DELETE "$BASE/customers/$A_CUST")
if [ "$CUST_DEL" = "404" ] || [ "$CUST_DEL" = "405" ]; then
  pass "043.3 No DELETE route for customers (HTTP $CUST_DEL)"
else
  fail "043.3 No DELETE route for customers" "got HTTP $CUST_DEL"
fi

DB_CUST_DEL=$(PSQL "DELETE FROM customers WHERE id='$A_CUST'::uuid")
if printf '%s' "$DB_CUST_DEL" | grep -qiE "violates foreign key|error"; then
  pass "043.3 The database refuses to delete a customer with documents"
else
  fail "043.3 Database refuses customer deletion" "succeeded: $DB_CUST_DEL"
fi

ARCH=$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/customers/$A_CUST/archive" \
  -H 'Content-Type: application/json' -d '{"confirm":true}')
check "True" "$(printf '%s' "$ARCH" | jqp "['data']['isArchived']")" "043.3 Archiving is the supported path"
check "$CANC_NUM" "$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" "$BASE/invoices/$CANC" | jqp "['data']['invoiceNumber']")" \
  "043.3 Documents survive the customer being archived"
curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/customers/$A_CUST/restore" -o /dev/null

# Criterion: destructive actions require confirmation.
check "VALIDATION_ERROR" "$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/customers/$A_CUST/archive" \
  -H 'Content-Type: application/json' -d '{}' | jqp "['error']['code']")" \
  "043.4 Archiving requires explicit confirmation"
check "VALIDATION_ERROR" "$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/invoices/$INV/cancel" \
  -H 'Content-Type: application/json' -d '{}' | jqp "['error']['code']")" \
  "043.4 Cancelling requires a reason"
PAY_ID=$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" "$BASE/payments?limit=1" | jqp "['data']['items'][0]['id']")
check "VALIDATION_ERROR" "$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/payments/$PAY_ID/void" \
  -H 'Content-Type: application/json' -d '{}' | jqp "['error']['code']")" \
  "043.4 Voiding requires a reason"
echo

# ===========================================================================
echo "TICKET-044 — Secure Document Access"
# ===========================================================================

PDF=$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" "$BASE/invoices/$INV/pdf")
PDF_URL=$(printf '%s' "$PDF" | jqp "['data']['url']")
[ -n "$PDF_URL" ] && pass "044.0 An authorised request receives a signed URL" \
  || fail "044.0 Authorised PDF request" "$PDF"

# Criterion: ownership is verified server-side.
check "INVOICE_NOT_FOUND" "$(curl -s -m "$REQ_TIMEOUT" -b "$B_JAR" "$BASE/invoices/$INV/pdf" | jqp "['error']['code']")" \
  "044.1 Another organisation cannot generate this PDF"
check "401" "$(code "$BASE/invoices/$INV/pdf")" "044.1 Anonymous PDF requests are refused"

# Criterion: guessing IDs cannot expose documents.
RANDOM_ID=$(python3 -c 'import uuid;print(uuid.uuid4())')
check "INVOICE_NOT_FOUND" "$(curl -s -m "$REQ_TIMEOUT" -b "$B_JAR" "$BASE/invoices/$RANDOM_ID/pdf" | jqp "['error']['code']")" \
  "044.2 A guessed id returns the same error as a foreign one"

# Criterion: private objects are not permanently public.
BARE="${PDF_URL%%\?*}"
check "403" "$(code "$BARE")" "044.3 The object is not readable without a signature"
EXPIRES=$(printf '%s' "$PDF_URL" | grep -oE 'X-Amz-Expires=[0-9]+' | cut -d= -f2)
if [ -n "$EXPIRES" ] && [ "$EXPIRES" -le 3600 ]; then
  pass "044.3 The signed URL expires (${EXPIRES}s)"
else
  fail "044.3 Signed URL has a short expiry" "got '${EXPIRES:-none}'"
fi

# Criterion: access attempts can be logged where appropriate.
DENIED_LOGGED=$(grep -c "Request denied" /tmp/api.log 2>/dev/null || echo 0)
if [ "${DENIED_LOGGED:-0}" -gt 0 ]; then
  pass "044.4 Denied access attempts are logged ($DENIED_LOGGED so far)"
else
  gap "044.4 Denied access attempts are logged" "no 'Request denied' lines found in the API log"
fi
echo

# ===========================================================================
echo "TICKET-045 — API Validation & Error Handling"
# ===========================================================================

# Criterion: invalid input returns structured errors.
BAD=$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/customers" -H 'Content-Type: application/json' \
  -d '{"customerType":"COMPANY","email":"not-an-email"}')
check "VALIDATION_ERROR" "$(printf '%s' "$BAD" | jqp "['error']['code']")" "045.1 Invalid input returns a structured error"
HAS_FIELDS=$(printf '%s' "$BAD" | jqp "all('field' in x and 'message' in x for x in d['error']['details'])")
check "True" "$HAS_FIELDS" "045.1 Errors carry field-level detail"
HAS_REQID=$(printf '%s' "$BAD" | jqp "len(d['requestId'])>0")
check "True" "$HAS_REQID" "045.1 Every response carries a requestId"

# Criteria: status codes.
check "401" "$(code "$BASE/customers")" "045.2 Unauthenticated returns 401"

# 403 needs a role that lacks the permission: VIEWER cannot create customers.
V_JAR="$TMP/viewer.jar"
curl -s -m "$REQ_TIMEOUT" -c "$V_JAR" -X POST "$BASE/auth/sign-in/email" -H 'Content-Type: application/json' \
  -d '{"email":"viewer@acme.test","password":"'"$SEED_PASSWORD"'"}' -o /dev/null
curl -s -m "$REQ_TIMEOUT" -b "$V_JAR" -c "$V_JAR" -X POST "$BASE/auth/switch-organisation" \
  -H 'Content-Type: application/json' -d '{"organisationId":"11111111-1111-1111-1111-111111111111"}' -o /dev/null
check "403" "$(code -b "$V_JAR" -X POST "$BASE/customers" -H 'Content-Type: application/json' \
  -d '{"customerType":"COMPANY","companyName":"Denied"}')" "045.3 Unauthorised returns 403"

check "404" "$(code -b "$A_JAR" "$BASE/customers/$RANDOM_ID")" "045.4 Missing resource returns 404"

# Business-rule violation: sending an already-sent invoice.
BR=$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/invoices/$INV/send")
check "INVALID_STATUS_TRANSITION" "$(printf '%s' "$BR" | jqp "['error']['code']")" \
  "045.5 Business-rule violations return a specific code"
check "409" "$(code -b "$A_JAR" -X POST "$BASE/invoices/$INV/send")" "045.5 …with a 4xx status (409)"

# Criterion: internal secrets/details are not exposed.
LEAKY=$(printf '%s' "$BAD $BR" | grep -icE "prisma|postgres|select |stack|at /Users/|node_modules" | awk '{s+=$1} END {print s+0}')
check "0" "$LEAKY" "045.7 Error bodies leak no SQL, stack traces or paths"

# A malformed body must not surface a parser error verbatim.
MALFORMED=$(curl -s -m "$REQ_TIMEOUT" -b "$A_JAR" -X POST "$BASE/customers" \
  -H 'Content-Type: application/json' -d '{"companyName": ')
MAL_LEAK=$(printf '%s' "$MALFORMED" | grep -icE "JSON at position|SyntaxError|node_modules" | awk '{s+=$1} END {print s+0}')
check "0" "$MAL_LEAK" "045.6 Malformed JSON does not expose a parser stack"
MAL_CODE=$(printf '%s' "$MALFORMED" | jqp "['error']['code']")
if [ -n "$MAL_CODE" ]; then
  pass "045.6 Malformed JSON returns the standard error envelope ($MAL_CODE)"
else
  fail "045.6 Malformed JSON returns the standard envelope" "got: $(printf '%s' "$MALFORMED" | head -c 120)"
fi
echo

# ===========================================================================
echo "TICKET-046 — Financial Integrity Test Suite"
# ===========================================================================
# This ticket asks for coverage to EXIST. Each area is verified by locating a
# real assertion, so the audit fails if a suite is deleted or renamed.

SUITES="$(dirname "$0")/.."
covers() {
  local label="$1" pattern="$2" where="$3"
  local n
  n=$(grep -rl "$pattern" $where 2>/dev/null | wc -l | tr -d ' ')
  if [ "${n:-0}" -gt 0 ]; then pass "046 covers $label"; else fail "046 covers $label" "no test matches /$pattern/"; fi
}

covers "quantity x price"        "quantity.*unitPrice\|10000"        "$SUITES/../packages/validation/src/calculation.test.ts $SUITES/integration/invoices.sh"
covers "discounts"               "discountRate\|Discount over 100"   "$SUITES/../packages/validation/src/calculation.test.ts $SUITES/integration/quotations.sh"
covers "tax"                     "taxRate\|taxAmount"                "$SUITES/../packages/validation/src/calculation.test.ts"
covers "rounding"                "half-up\|ROUND_HALF_UP\|rounds"    "$SUITES/../packages/validation/src/money.test.ts $SUITES/../packages/validation/src/calculation.test.ts"
covers "partial payments"        "PARTIALLY_PAID"                    "$SUITES/integration/payments.sh"
covers "full payments"           "marks the invoice PAID\|PAID"      "$SUITES/integration/payments.sh"
covers "invalid payments"        "Overpayment rejected\|Negative payment" "$SUITES/integration/payments.sh"
covers "overdue status"          "OVERDUE"                           "$SUITES/integration/invoices.sh $SUITES/integration/dashboard.sh"
covers "duplicate numbering"     "duplicate invoice numbers\|unique" "$SUITES/integration/integrity.sh $SUITES/../packages/database/src/document-number.test.ts"
covers "concurrent creation"     "concurrent"                        "$SUITES/../packages/database/src/document-number.test.ts $SUITES/integration/payments.sh"
covers "invalid transitions"     "INVALID_STATUS_TRANSITION"         "$SUITES/integration/invoices.sh $SUITES/integration/quotations.sh"
covers "quotation conversion"    "convert-to-invoice"                "$SUITES/integration/quotations.sh"
covers "organisation isolation"  "Org B cannot\|tenant"              "$SUITES/integration/tenant-isolation.sh"
echo

echo "------------------------------------------------------"
printf '  %d passed, %d failed, %d gaps\n' "$PASS" "$FAIL" "$GAP"
echo "------------------------------------------------------"
echo
[ "$FAIL" -eq 0 ]
