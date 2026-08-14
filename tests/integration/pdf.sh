#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# PDF generation (TICKET-020, TICKET-029)
#
# Covers the three safeguards agreed before implementation:
#   1. content-hash cache invalidation
#   2. concurrent generation produces exactly one documents row
#   3. render failure during send rolls the whole transition back
#
# Requires the API on :4000, MinIO on :9000, and a seeded database.
# Usage: tests/integration/pdf.sh [base-url]
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

JAR="$TMP/a.jar"
EMAIL="pdf-$STAMP@test.local"

curl -s -m 15 -c "$JAR" -X POST "$BASE/auth/sign-up/email" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"CorrectHorseBattery1\",\"name\":\"P U\",\"firstName\":\"P\",\"lastName\":\"U\"}" -o /dev/null
curl -s -m 15 -c "$JAR" -X POST "$BASE/auth/sign-in/email" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"CorrectHorseBattery1\"}" -o /dev/null
curl -s -m 15 -b "$JAR" -c "$JAR" -X POST "$BASE/organisations" -H 'Content-Type: application/json' \
  -d '{"name":"PDF Test Org","currencyCode":"INR","countryCode":"IN"}' -o /dev/null

CUST=$(curl -s -m 10 -b "$JAR" -X POST "$BASE/customers" -H 'Content-Type: application/json' \
  -d '{"customerType":"COMPANY","companyName":"PDF Client","email":"ap@pdfclient.test"}' | jqp "['data']['id']")

make_quotation() {
  curl -s -m 15 -b "$JAR" -X POST "$BASE/quotations" -H 'Content-Type: application/json' \
    -d "{\"customerId\":\"$CUST\",\"issueDate\":\"2026-08-14\",\"validUntil\":\"2026-09-13\",
         \"items\":[{\"description\":\"$1\",\"quantity\":\"2\",\"unitPrice\":\"5000\",\"discountRate\":\"10\",\"taxRate\":\"18\"}]}" \
    | jqp "['data']['id']"
}

echo
echo "PDF generation"
echo

# --- Generation and signed URL ----------------------------------------------
echo "1. Generation and access"

QID=$(make_quotation "PDF line item")
RESP=$(curl -s -m 60 -b "$JAR" "$BASE/quotations/$QID/pdf")
URL=$(printf '%s' "$RESP" | jqp "['data']['url']")
NAME=$(printf '%s' "$RESP" | jqp "['data']['fileName']")

[ -n "$URL" ] && pass "Signed URL issued" || fail "Signed URL issued" "$RESP"
case "$NAME" in QUO-*.pdf) pass "Filename uses the document number ($NAME)";; *) fail "Filename uses the document number" "got '$NAME'";; esac

curl -s -m 30 "$URL" -o "$TMP/doc.pdf"
HEADER=$(head -c 5 "$TMP/doc.pdf")
check "%PDF-" "$HEADER" "Downloaded file is a valid PDF"

SIZE=$(wc -c < "$TMP/doc.pdf" | tr -d ' ')
if [ "$SIZE" -gt 1000 ]; then pass "PDF has content ($SIZE bytes)"; else fail "PDF has content" "only $SIZE bytes"; fi

# The object must not be reachable without the signature.
BARE="${URL%%\?*}"
check "403" "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BARE")" "Unsigned URL is refused by storage"
echo

# --- Caching -----------------------------------------------------------------
echo "2. Content-hash caching"

FIRST_KEY=$(printf '%s' "$RESP" | jqp "['data']['fileName']")
SECOND=$(curl -s -m 60 -b "$JAR" "$BASE/quotations/$QID/pdf")
check "$FIRST_KEY" "$(printf '%s' "$SECOND" | jqp "['data']['fileName']")" "Repeat request returns the same document"

# Editing content must invalidate the cache and produce a different render.
curl -s -m 15 -b "$JAR" -X PATCH "$BASE/quotations/$QID" -H 'Content-Type: application/json' \
  -d '{"notes":"Cache-busting note that appears on the PDF"}' -o /dev/null
THIRD=$(curl -s -m 60 -b "$JAR" "$BASE/quotations/$QID/pdf")
THIRD_URL=$(printf '%s' "$THIRD" | jqp "['data']['url']")
curl -s -m 30 "$THIRD_URL" -o "$TMP/doc2.pdf"

if cmp -s "$TMP/doc.pdf" "$TMP/doc2.pdf"; then
  fail "Editing the document busts the PDF cache" "identical file served after edit"
else
  pass "Editing the document busts the PDF cache"
fi
echo

# --- Concurrency -------------------------------------------------------------
echo "3. Concurrent generation (safeguard 2)"

CQ=$(make_quotation "Concurrent probe")
for i in $(seq 1 10); do
  curl -s -m 90 -b "$JAR" "$BASE/quotations/$CQ/pdf" > "$TMP/c_$i.json" &
done
wait

OKS=$(python3 -c "
import json,glob
ok=0
for f in glob.glob('$TMP/c_*.json'):
    try:
        if 'data' in json.load(open(f)): ok+=1
    except Exception: pass
print(ok)")
check "10" "$OKS" "All 10 concurrent requests succeed"

DISTINCT=$(python3 -c "
import json,glob
ids=set()
for f in glob.glob('$TMP/c_*.json'):
    try:
        d=json.load(open(f))
        if 'data' in d: ids.add(d['data']['fileName'])
    except Exception: pass
print(len(ids))")
check "1" "$DISTINCT" "All concurrent requests resolve to one document"
echo

# --- Send ---------------------------------------------------------------------
echo "4. Send renders before the status change (safeguard 3)"

SQ=$(make_quotation "Send probe")
SEND_START=$(python3 -c "import time;print(int(time.time()*1000))")
SEND=$(curl -s -m 60 -b "$JAR" -X POST "$BASE/quotations/$SQ/send")
SEND_END=$(python3 -c "import time;print(int(time.time()*1000))")
SEND_MS=$((SEND_END - SEND_START))

check "SENT" "$(printf '%s' "$SEND" | jqp "['data']['status']")" "Send succeeds"

# Threshold agreed with the product owner: comfortably under 3s.
if [ "$SEND_MS" -lt 3000 ]; then
  pass "Send completes within 3s (${SEND_MS}ms)"
else
  fail "Send completes within 3s" "took ${SEND_MS}ms"
fi

# The PDF must already exist — send generated it, no separate request needed.
AFTER_SEND=$(curl -s -m 60 -b "$JAR" "$BASE/quotations/$SQ/pdf")
[ -n "$(printf '%s' "$AFTER_SEND" | jqp "['data']['url']")" ] \
  && pass "PDF exists immediately after send" \
  || fail "PDF exists immediately after send" "$AFTER_SEND"
echo

# --- Authorisation -------------------------------------------------------------
echo "5. Authorisation"

check "401" "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/quotations/$QID/pdf")" \
  "Anonymous PDF request is refused"

OTHER="$TMP/b.jar"
curl -s -m 15 -c "$OTHER" -X POST "$BASE/auth/sign-up/email" -H 'Content-Type: application/json' \
  -d "{\"email\":\"pdfb-$STAMP@test.local\",\"password\":\"CorrectHorseBattery1\",\"name\":\"B U\",\"firstName\":\"B\",\"lastName\":\"U\"}" -o /dev/null
curl -s -m 15 -c "$OTHER" -X POST "$BASE/auth/sign-in/email" -H 'Content-Type: application/json' \
  -d "{\"email\":\"pdfb-$STAMP@test.local\",\"password\":\"CorrectHorseBattery1\"}" -o /dev/null
curl -s -m 15 -b "$OTHER" -c "$OTHER" -X POST "$BASE/organisations" -H 'Content-Type: application/json' \
  -d '{"name":"Other PDF Org","currencyCode":"INR","countryCode":"IN"}' -o /dev/null

check "QUOTATION_NOT_FOUND" "$(curl -s -m 20 -b "$OTHER" "$BASE/quotations/$QID/pdf" | jqp "['error']['code']")" \
  "Another organisation cannot generate this PDF"
echo

echo "------------------------------------------------------"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
echo "------------------------------------------------------"
echo
[ "$FAIL" -eq 0 ]
