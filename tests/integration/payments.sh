#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# EPIC 5 — Payments (TICKET-031 … TICKET-034)
#
# Includes the concurrency cases required by ADR-009:
#   - N simultaneous payments on one invoice must not overpay
#   - a void racing a new payment on the same invoice
#   - two simultaneous voids of the same payment
#
# Also closes out the BILLING PAID-cancel case, which needed a recorded
# payment to be testable through the API.
#
# Requires the API on :4000 and a seeded database.
# Usage: tests/integration/payments.sh [base-url]
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
try: print(eval(expr,{'d':d,'len':len}))
except Exception: print('')" "$1" 2>/dev/null; }

is_uuid() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; }

A_JAR="$TMP/a.jar"
B_JAR="$TMP/b.jar"

setup_org() {
  local email="$1" jar="$2" name="$3"
  curl -s -m 15 -c "$jar" -X POST "$BASE/auth/sign-up/email" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"CorrectHorseBattery1\",\"name\":\"P U\",\"firstName\":\"P\",\"lastName\":\"U\"}" -o /dev/null
  curl -s -m 15 -c "$jar" -X POST "$BASE/auth/sign-in/email" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"CorrectHorseBattery1\"}" -o /dev/null
  curl -s -m 15 -b "$jar" -c "$jar" -X POST "$BASE/organisations" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\",\"currencyCode\":\"INR\",\"countryCode\":\"IN\"}" | jqp "['data']['id']"
}

# Creates a SENT invoice with the given pre-tax amount; echoes its id.
sent_invoice() {
  local jar="$1" customer="$2" price="$3" desc="${4:-Payable item}"
  local id
  id=$(curl -s -m 15 -b "$jar" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
    -d "{\"customerId\":\"$customer\",\"paymentMethod\":\"BANK_TRANSFER\",\"issueDate\":\"$TODAY\",
         \"items\":[{\"description\":\"$desc\",\"quantity\":\"1\",\"unitPrice\":\"$price\",\"taxRate\":\"0\"}]}" \
    | jqp "['data']['id']")
  curl -s -m 60 -b "$jar" -X POST "$BASE/invoices/$id/send" -o /dev/null
  printf '%s' "$id"
}

pay() {
  local jar="$1" invoice="$2" amount="$3" key="$4"
  curl -s -m 30 -b "$jar" -X POST "$BASE/invoices/$invoice/payments" -H 'Content-Type: application/json' \
    -d "{\"amount\":\"$amount\",\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"BANK_TRANSFER\",\"idempotencyKey\":\"$key\"}"
}

invoice_field() { curl -s -m 10 -b "$1" "$BASE/invoices/$2" | jqp "['data']['$3']"; }

echo
echo "EPIC 5 — Payments"
echo

A_ORG=$(setup_org "pay-a-$STAMP@test.local" "$A_JAR" "Pay Org A")
B_ORG=$(setup_org "pay-b-$STAMP@test.local" "$B_JAR" "Pay Org B")
A_CUST=$(curl -s -m 10 -b "$A_JAR" -X POST "$BASE/customers" -H 'Content-Type: application/json' \
  -d '{"customerType":"COMPANY","companyName":"Paying Client","billing":{"addressLine1":"1 High St","city":"Pune","state":"Maharashtra","postalCode":"411001","countryCode":"IN"}}' | jqp "['data']['id']")
for pair in "A_ORG:$A_ORG" "B_ORG:$B_ORG" "A_CUST:$A_CUST"; do
  is_uuid "${pair#*:}" || { echo "  fixture setup failed: ${pair%%:*}='${pair#*:}'"; exit 1; }
done
echo "  Org A: $A_ORG"
echo

# --- Recording -----------------------------------------------------------------
echo "1. Recording a payment (TICKET-031)"

INV=$(sent_invoice "$A_JAR" "$A_CUST" "10000")
check "10000" "$(invoice_field "$A_JAR" "$INV" amountDue)" "New invoice owes its full total"

PAID=$(pay "$A_JAR" "$INV" "4000" "key-partial-$STAMP")
check "PAY-000001" "$(printf '%s' "$PAID" | jqp "['data']['payment']['paymentNumber']")" "Payment numbered from the sequence"
check "False" "$(printf '%s' "$PAID" | jqp "['data']['replayed']")" "First call is not a replay"
check "PARTIALLY_PAID" "$(printf '%s' "$PAID" | jqp "['data']['invoice']['status']")" "Invoice becomes PARTIALLY_PAID"
check "6000" "$(invoice_field "$A_JAR" "$INV" amountDue)" "Balance reduced by the payment"
check "4000" "$(invoice_field "$A_JAR" "$INV" amountPaid)" "amountPaid reflects the payment"
echo

# --- Validation -----------------------------------------------------------------
echo "2. Validation (Security Doc §30, §34)"

check "VALIDATION_ERROR" "$(pay "$A_JAR" "$INV" "0" "key-zero-$STAMP" | jqp "['error']['code']")" \
  "Zero payment rejected"
check "VALIDATION_ERROR" "$(pay "$A_JAR" "$INV" "-100" "key-neg-$STAMP" | jqp "['error']['code']")" \
  "Negative payment rejected"
check "VALIDATION_ERROR" "$(pay "$A_JAR" "$INV" "999999" "key-over-$STAMP" | jqp "['error']['code']")" \
  "Overpayment rejected"

FUTURE=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=5)).isoformat())")
FUT_BODY=$(curl -s -m 20 -b "$A_JAR" -X POST "$BASE/invoices/$INV/payments" -H 'Content-Type: application/json' \
  -d "{\"amount\":\"100\",\"paymentDate\":\"${FUTURE}\",\"paymentMethod\":\"CASH\",\"idempotencyKey\":\"key-fut-$STAMP\"}")
check "VALIDATION_ERROR" "$(printf '%s' "$FUT_BODY" | jqp "['error']['code']")" "Future-dated payment rejected"

NOKEY=$(curl -s -m 20 -b "$A_JAR" -X POST "$BASE/invoices/$INV/payments" -H 'Content-Type: application/json' \
  -d "{\"amount\":\"100\",\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"CASH\"}")
check "VALIDATION_ERROR" "$(printf '%s' "$NOKEY" | jqp "['error']['code']")" "Missing idempotency key rejected"

# A draft invoice cannot receive payment — it was never issued.
DRAFT=$(curl -s -m 15 -b "$A_JAR" -X POST "$BASE/invoices" -H 'Content-Type: application/json' \
  -d "{\"customerId\":\"$A_CUST\",\"paymentMethod\":\"BANK_TRANSFER\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Draft\",\"quantity\":\"1\",\"unitPrice\":\"100\"}]}" \
  | jqp "['data']['id']")
check "INVALID_STATUS_TRANSITION" "$(pay "$A_JAR" "$DRAFT" "50" "key-draft-$STAMP" | jqp "['error']['code']")" \
  "Cannot pay a DRAFT invoice"

# Balance must be untouched by every rejection above.
check "6000" "$(invoice_field "$A_JAR" "$INV" amountDue)" "Rejected payments left the balance unchanged"
echo

# --- Idempotency ------------------------------------------------------------------
echo "3. Idempotency (Security Doc §19)"

REPLAY=$(pay "$A_JAR" "$INV" "4000" "key-partial-$STAMP")
check "True" "$(printf '%s' "$REPLAY" | jqp "['data']['replayed']")" "Same key returns the original payment"
check "PAY-000001" "$(printf '%s' "$REPLAY" | jqp "['data']['payment']['paymentNumber']")" "Replay returns the same payment number"
check "6000" "$(invoice_field "$A_JAR" "$INV" amountDue)" "Replay did not take the money twice"

# The same key against a different invoice is a client bug, not a replay.
OTHER=$(sent_invoice "$A_JAR" "$A_CUST" "500" "Other invoice")
check "IDEMPOTENCY_KEY_REUSED" "$(pay "$A_JAR" "$OTHER" "100" "key-partial-$STAMP" | jqp "['error']['code']")" \
  "Key reused across invoices is refused"
echo

# --- Full payment -------------------------------------------------------------------
echo "4. Settling an invoice (TICKET-032)"

FINAL=$(pay "$A_JAR" "$INV" "6000" "key-final-$STAMP")
check "PAID" "$(printf '%s' "$FINAL" | jqp "['data']['invoice']['status']")" "Exact final payment marks the invoice PAID"
check "0" "$(invoice_field "$A_JAR" "$INV" amountDue)" "Balance is zero once settled"
check "10000" "$(invoice_field "$A_JAR" "$INV" amountPaid)" "amountPaid equals the invoice total"
check "INVALID_STATUS_TRANSITION" "$(pay "$A_JAR" "$INV" "1" "key-after-$STAMP" | jqp "['error']['code']")" \
  "Cannot pay an already-PAID invoice"
echo

# --- Concurrency: simultaneous payments ------------------------------------------------
echo "5. Concurrent payments on one invoice (ADR-009)"

CONC=$(sent_invoice "$A_JAR" "$A_CUST" "1000" "Concurrent target")
# Ten simultaneous payments of 200 against a balance of 1000: exactly five can
# succeed. Without the row lock, all ten would read a 1000 balance and overpay.
for i in $(seq 1 10); do
  pay "$A_JAR" "$CONC" "200" "conc-$STAMP-$i" > "$TMP/p_$i.json" &
done
wait

SUCCEEDED=$(python3 -c "
import json,glob
ok=0
for f in glob.glob('$TMP/p_*.json'):
    try:
        d=json.load(open(f))
        if 'data' in d and not d['data'].get('replayed'): ok+=1
    except Exception: pass
print(ok)")
check "5" "$SUCCEEDED" "Exactly five of ten concurrent payments succeed"
check "0" "$(invoice_field "$A_JAR" "$CONC" amountDue)" "Balance lands exactly at zero, never negative"
check "1000" "$(invoice_field "$A_JAR" "$CONC" amountPaid)" "amountPaid never exceeds the total"
check "PAID" "$(invoice_field "$A_JAR" "$CONC" status)" "Invoice ends PAID"
echo

# --- Voiding ------------------------------------------------------------------------
echo "6. Voiding a payment"

VINV=$(sent_invoice "$A_JAR" "$A_CUST" "2000" "Void target")
VPAY=$(pay "$A_JAR" "$VINV" "800" "void-one-$STAMP" | jqp "['data']['payment']['id']")
check "1200" "$(invoice_field "$A_JAR" "$VINV" amountDue)" "Balance reduced before the void"

check "VALIDATION_ERROR" "$(curl -s -m 20 -b "$A_JAR" -X POST "$BASE/payments/$VPAY/void" \
  -H 'Content-Type: application/json' -d '{}' | jqp "['error']['code']")" "Void requires a reason"

VOIDED=$(curl -s -m 20 -b "$A_JAR" -X POST "$BASE/payments/$VPAY/void" \
  -H 'Content-Type: application/json' -d '{"reason":"Cheque bounced"}')
check "VOIDED" "$(printf '%s' "$VOIDED" | jqp "['data']['payment']['status']")" "Payment marked VOIDED"
check "2000" "$(invoice_field "$A_JAR" "$VINV" amountDue)" "Void restores the invoice balance"
check "0" "$(invoice_field "$A_JAR" "$VINV" amountPaid)" "Void clears amountPaid"
check "SENT" "$(invoice_field "$A_JAR" "$VINV" status)" "Invoice returns to SENT"

# The payment row survives — voided, not deleted.
check "VOIDED" "$(curl -s -m 10 -b "$A_JAR" "$BASE/payments/$VPAY" | jqp "['data']['status']")" \
  "Voided payment is retained, not deleted"
DELETE_CODE=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -b "$A_JAR" -X DELETE "$BASE/payments/$VPAY")
if [ "$DELETE_CODE" = "404" ] || [ "$DELETE_CODE" = "405" ]; then
  pass "No DELETE endpoint for payments (HTTP $DELETE_CODE)"
else
  fail "No DELETE endpoint for payments" "got HTTP $DELETE_CODE"
fi
echo

# --- Concurrency: double void -----------------------------------------------------------
echo "7. Two simultaneous voids of one payment"

DINV=$(sent_invoice "$A_JAR" "$A_CUST" "3000" "Double void target")
DPAY=$(pay "$A_JAR" "$DINV" "1200" "dvoid-$STAMP" | jqp "['data']['payment']['id']")

for i in 1 2 3 4; do
  curl -s -m 25 -b "$A_JAR" -X POST "$BASE/payments/$DPAY/void" \
    -H 'Content-Type: application/json' -d '{"reason":"Simultaneous void '"$i"'"}' > "$TMP/v_$i.json" &
done
wait

VOID_OK=$(python3 -c "
import json,glob
ok=0
for f in glob.glob('$TMP/v_*.json'):
    try:
        d=json.load(open(f))
        if 'data' in d: ok+=1
    except Exception: pass
print(ok)")
check "1" "$VOID_OK" "Exactly one void succeeds; the rest fail cleanly"
check "3000" "$(invoice_field "$A_JAR" "$DINV" amountDue)" "Balance reversed once, not multiple times"
check "0" "$(invoice_field "$A_JAR" "$DINV" amountPaid)" "amountPaid is zero, not negative"
echo

# --- Concurrency: void racing a new payment ------------------------------------------------
echo "8. Void racing a new payment on the same invoice"

RINV=$(sent_invoice "$A_JAR" "$A_CUST" "5000" "Race target")
RPAY=$(pay "$A_JAR" "$RINV" "2000" "race-first-$STAMP" | jqp "['data']['payment']['id']")

# Fire both at once: void the existing 2000 payment while recording a new 1500.
curl -s -m 25 -b "$A_JAR" -X POST "$BASE/payments/$RPAY/void" \
  -H 'Content-Type: application/json' -d '{"reason":"Race void"}' > "$TMP/race_void.json" &
pay "$A_JAR" "$RINV" "1500" "race-new-$STAMP" > "$TMP/race_pay.json" &
wait

VOID_WON=$(python3 -c "
import json
try: print('yes' if 'data' in json.load(open('$TMP/race_void.json')) else 'no')
except Exception: print('no')")
PAY_WON=$(python3 -c "
import json
try:
    d=json.load(open('$TMP/race_pay.json'))
    print('yes' if 'data' in d else 'no')
except Exception: print('no')")

echo "        (void succeeded: $VOID_WON, new payment succeeded: $PAY_WON)"

# Whichever order the lock allowed, the stored balance must equal the invoice
# total minus the sum of payments that are still RECORDED.
DUE=$(invoice_field "$A_JAR" "$RINV" amountDue)
PAID_NOW=$(invoice_field "$A_JAR" "$RINV" amountPaid)
EXPECTED=$(python3 -c "
void_won = '$VOID_WON' == 'yes'
pay_won  = '$PAY_WON' == 'yes'
paid = 0
if not void_won: paid += 2000
if pay_won: paid += 1500
print(f'{paid}')")
check "$EXPECTED" "$PAID_NOW" "amountPaid matches the surviving RECORDED payments"
check "$(python3 -c "print(5000-int('$EXPECTED'))")" "$DUE" "Balance is consistent regardless of which won"

# And the ledger must agree with the stored figure.
LEDGER=$(curl -s -m 10 -b "$A_JAR" "$BASE/invoices/$RINV" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
total=sum(float(a['allocatedAmount']) for a in d['allocations'] if a['payment']['status']=='RECORDED')
print(int(total))")
check "$EXPECTED" "$LEDGER" "Stored amountPaid agrees with the allocation ledger"
echo

# --- BILLING scoped rules ------------------------------------------------------------------
echo "9. BILLING scoped permissions (Security Doc §12)"

BILL_JAR="$TMP/billing.jar"
curl -s -m 15 -c "$BILL_JAR" -X POST "$BASE/auth/sign-in/email" -H 'Content-Type: application/json' \
  -d '{"email":"billing@acme.test","password":"DevPassword123!"}' -o /dev/null
curl -s -m 10 -b "$BILL_JAR" -c "$BILL_JAR" -X POST "$BASE/auth/switch-organisation" \
  -H 'Content-Type: application/json' -d '{"organisationId":"11111111-1111-1111-1111-111111111111"}' -o /dev/null

SEED_CUST=$(curl -s -m 10 -b "$BILL_JAR" "$BASE/customers?limit=1" | jqp "['data']['items'][0]['id']")
if is_uuid "$SEED_CUST"; then
  # Closes out the case deferred from EPIC 4: BILLING must not cancel a PAID
  # invoice, which needed a recorded payment to reach through the API.
  BPAID=$(sent_invoice "$BILL_JAR" "$SEED_CUST" "700" "Billing paid invoice")
  pay "$BILL_JAR" "$BPAID" "700" "bill-paid-$STAMP" > /dev/null
  check "PAID" "$(invoice_field "$BILL_JAR" "$BPAID" status)" "BILLING can settle an invoice"
  check "FORBIDDEN" "$(curl -s -m 20 -b "$BILL_JAR" -X POST "$BASE/invoices/$BPAID/cancel" \
    -H 'Content-Type: application/json' -d '{"reason":"Should be refused"}' | jqp "['error']['code']")" \
    "BILLING cannot cancel a PAID invoice"

  # OWNER may, because the §12 restriction applies only to BILLING.
  OWNER_JAR="$TMP/owner.jar"
  curl -s -m 15 -c "$OWNER_JAR" -X POST "$BASE/auth/sign-in/email" -H 'Content-Type: application/json' \
    -d '{"email":"owner@acme.test","password":"DevPassword123!"}' -o /dev/null
  curl -s -m 10 -b "$OWNER_JAR" -c "$OWNER_JAR" -X POST "$BASE/auth/switch-organisation" \
    -H 'Content-Type: application/json' -d '{"organisationId":"11111111-1111-1111-1111-111111111111"}' -o /dev/null

  # Even OWNER must void the payments first — money cannot be orphaned.
  check "INVALID_STATUS_TRANSITION" "$(curl -s -m 20 -b "$OWNER_JAR" -X POST "$BASE/invoices/$BPAID/cancel" \
    -H 'Content-Type: application/json' -d '{"reason":"Owner attempt with payments attached"}' | jqp "['error']['code']")" \
    "Even OWNER cannot cancel an invoice holding payments"

  # BILLING may void a payment it recorded.
  BVINV=$(sent_invoice "$BILL_JAR" "$SEED_CUST" "400" "Billing void own")
  BVPAY=$(pay "$BILL_JAR" "$BVINV" "400" "bill-void-$STAMP" | jqp "['data']['payment']['id']")
  check "VOIDED" "$(curl -s -m 20 -b "$BILL_JAR" -X POST "$BASE/payments/$BVPAY/void" \
    -H 'Content-Type: application/json' -d '{"reason":"Billing voids its own payment"}' | jqp "['data']['payment']['status']")" \
    "BILLING may void a payment it recorded"

  # But not one recorded by someone else.
  OINV=$(sent_invoice "$OWNER_JAR" "$SEED_CUST" "600" "Owner recorded")
  OPAY=$(pay "$OWNER_JAR" "$OINV" "600" "owner-pay-$STAMP" | jqp "['data']['payment']['id']")
  check "FORBIDDEN" "$(curl -s -m 20 -b "$BILL_JAR" -X POST "$BASE/payments/$OPAY/void" \
    -H 'Content-Type: application/json' -d '{"reason":"Billing voids someone else"}' | jqp "['error']['code']")" \
    "BILLING cannot void another user's payment"
else
  fail "BILLING scoped permissions" "could not load a seeded customer"
fi
echo

# --- Tenant isolation -------------------------------------------------------------------------
echo "10. Tenant isolation"

check "0" "$(curl -s -m 10 -b "$B_JAR" "$BASE/payments" | jqp "['data']['total']")" \
  "Org B sees none of Org A's payments"
check "PAYMENT_NOT_FOUND" "$(curl -s -m 10 -b "$B_JAR" "$BASE/payments/$VPAY" | jqp "['error']['code']")" \
  "Org B cannot read Org A's payment"
check "PAYMENT_NOT_FOUND" "$(curl -s -m 20 -b "$B_JAR" -X POST "$BASE/payments/$VPAY/void" \
  -H 'Content-Type: application/json' -d '{"reason":"x"}' | jqp "['error']['code']")" \
  "Org B cannot void Org A's payment"
check "INVOICE_NOT_FOUND" "$(pay "$B_JAR" "$INV" "10" "cross-$STAMP" | jqp "['error']['code']")" \
  "Org B cannot pay Org A's invoice"
echo

echo "------------------------------------------------------"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
echo "------------------------------------------------------"
echo
[ "$FAIL" -eq 0 ]
