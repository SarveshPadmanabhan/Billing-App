#!/usr/bin/env bash
#
# Drop the database and rebuild it empty from the migrations.
#
# For preparing a handover or a fresh environment. Everything is destroyed:
# organisations, users, invoices, payments, audit logs. There is no partial
# mode — "delete the test data" is not a thing this can know how to do, so it
# does the one unambiguous thing instead.
#
# Usage:
#   ./scripts/reset-database.sh                    # billing_dev, prompts first
#   DB_NAME=billing_staging ./scripts/reset-database.sh
#   ./scripts/reset-database.sh --yes              # skip the prompt (CI)
#
# Takes a backup first, always, and prints how to restore it.

set -euo pipefail

# Locate psql. Homebrew does not put versioned Postgres on PATH; Linux and
# Windows (Git Bash) normally do. Only prepend a path that actually exists, so
# this works unchanged on macOS, Linux and Git Bash / WSL.
for CANDIDATE in \
  /opt/homebrew/opt/postgresql@16/bin \
  /usr/local/opt/postgresql@16/bin \
  /usr/lib/postgresql/16/bin \
  "/c/Program Files/PostgreSQL/16/bin"; do
  [ -d "$CANDIDATE" ] && export PATH="$CANDIDATE:$PATH" && break
done

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found. Install PostgreSQL 16 and ensure psql is on PATH." >&2
  exit 1
fi

DB_NAME="${DB_NAME:-billing_dev}"
DB_HOST="${DB_HOST:-localhost}"
SUPERUSER="${DB_SUPERUSER:-$(whoami)}"
BACKUP_DIR="${BACKUP_DIR:-/tmp/billing-backup}"

# Refuse in production. A wipe is never the right automated answer there, and
# NODE_ENV is the same signal the demo-reset script already honours.
if [ "${NODE_ENV:-}" = "production" ]; then
  echo "Refusing to run with NODE_ENV=production." >&2
  exit 1
fi
case "$DB_NAME" in
  *prod*|*production*)
    echo "Refusing: database name '$DB_NAME' looks like production." >&2
    exit 1
    ;;
esac

if ! psql -h "$DB_HOST" -U "$SUPERUSER" -d postgres -tAc \
       "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  echo "Database '$DB_NAME' does not exist; nothing to reset."
  exit 0
fi

# Show what is about to be lost, rather than asking to confirm a blank cheque.
echo "About to DESTROY everything in '$DB_NAME':"
psql -h "$DB_HOST" -U "$SUPERUSER" -d "$DB_NAME" -tAc "
SELECT '  organisations: '||count(*)::text FROM organisations;
SELECT '  users:         '||count(*)::text FROM users;
SELECT '  invoices:      '||count(*)::text FROM invoices;
SELECT '  payments:      '||count(*)::text FROM payments;
SELECT '  audit logs:    '||count(*)::text FROM audit_logs;" 2>/dev/null || true

if [ "${1:-}" != "--yes" ]; then
  printf "\nType the database name to confirm: "
  read -r REPLY
  if [ "$REPLY" != "$DB_NAME" ]; then
    echo "Aborted."
    exit 1
  fi
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$BACKUP_DIR/$DB_NAME-before-reset-$STAMP.dump"
echo
echo "Backing up to $BACKUP"
pg_dump -h "$DB_HOST" -U "$SUPERUSER" -d "$DB_NAME" -Fc -f "$BACKUP"

echo "Dropping and recreating '$DB_NAME'"

# A running dev server holds connections and dropdb refuses while they exist.
# Terminate them first, otherwise the reset dies here having already taken a
# backup — a confusing place to stop.
psql -h "$DB_HOST" -U "$SUPERUSER" -d postgres -tAc "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE datname='$DB_NAME' AND pid <> pg_backend_pid();" >/dev/null

dropdb -h "$DB_HOST" -U "$SUPERUSER" "$DB_NAME"
DB_NAME="$DB_NAME" DB_HOST="$DB_HOST" "$(dirname "$0")/setup-database.sh" >/dev/null

echo "Applying migrations"
( cd "$(dirname "$0")/../packages/database" && pnpm exec dotenv -e ../../.env -- prisma migrate deploy >/dev/null )

# Verify the result rather than trusting the exit codes above.
TABLES=$(psql -h "$DB_HOST" -U "$SUPERUSER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" | tr -d ' ')
ROWS=$(psql -h "$DB_HOST" -U "$SUPERUSER" -d "$DB_NAME" -tAc \
  "SELECT (SELECT count(*) FROM organisations)+(SELECT count(*) FROM users)+(SELECT count(*) FROM invoices);" | tr -d ' ')

echo
echo "Result: $TABLES tables, $ROWS rows of business data"
if [ "$ROWS" != "0" ]; then
  echo "FAIL: expected an empty database but found $ROWS rows." >&2
  exit 1
fi
if [ "$TABLES" -lt 20 ]; then
  echo "FAIL: only $TABLES tables; migrations did not complete." >&2
  exit 1
fi

echo "Done. Restore with:"
echo "  pg_restore -h $DB_HOST -U $SUPERUSER -d $DB_NAME --clean $BACKUP"
