#!/usr/bin/env bash
#
# Create the database and its two roles from scratch.
#
# Idempotent: safe to re-run. Creates nothing that already exists, and never
# drops or truncates anything.
#
# Usage:
#   ./scripts/setup-database.sh                  # billing_dev
#   DB_NAME=billing_prod ./scripts/setup-database.sh
#
# After this, run the migrations:
#   pnpm db:migrate:deploy

set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"

DB_NAME="${DB_NAME:-billing_dev}"
DB_HOST="${DB_HOST:-localhost}"
OWNER_PW="${OWNER_PASSWORD:-billing_owner}"
APP_PW="${APP_PASSWORD:-billing_app}"

echo "Setting up '$DB_NAME' on $DB_HOST"

# --- roles -------------------------------------------------------------------
#
# billing_owner: owns the schema and runs migrations.
#   CREATEDB   — Prisma Migrate needs a shadow database.
#   BYPASSRLS  — every tenant table uses FORCE ROW LEVEL SECURITY, which applies
#                to the table owner too. Without this a data migration reads
#                zero rows and silently does nothing while reporting success.
#
# billing_app: the runtime role. Deliberately WITHOUT BYPASSRLS — RLS applying
#   to application queries is the tenant isolation guarantee.
psql -h "$DB_HOST" -d postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='billing_owner') THEN
    CREATE ROLE billing_owner LOGIN PASSWORD '$OWNER_PW' CREATEDB BYPASSRLS;
    RAISE NOTICE 'created role billing_owner';
  ELSE
    ALTER ROLE billing_owner CREATEDB BYPASSRLS;
    RAISE NOTICE 'billing_owner already existed; ensured CREATEDB and BYPASSRLS';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='billing_app') THEN
    CREATE ROLE billing_app LOGIN PASSWORD '$APP_PW';
    RAISE NOTICE 'created role billing_app';
  END IF;

  -- Never grant this to the runtime role: it would defeat row-level security.
  ALTER ROLE billing_app NOBYPASSRLS;
END
\$\$;
SQL

# --- database ----------------------------------------------------------------
if psql -h "$DB_HOST" -d postgres -tAc \
     "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  echo "  database '$DB_NAME' already exists, leaving it alone"
else
  createdb -h "$DB_HOST" -O billing_owner "$DB_NAME"
  echo "  created database '$DB_NAME'"
fi

# --- privileges --------------------------------------------------------------
psql -h "$DB_HOST" -d "$DB_NAME" <<SQL
-- Postgres 15+ revokes CREATE on the public schema by default. Without this
-- the first migration fails with "permission denied for schema public".
GRANT ALL ON SCHEMA public TO billing_owner;

GRANT USAGE ON SCHEMA public TO billing_app;
ALTER DEFAULT PRIVILEGES FOR ROLE billing_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO billing_app;
ALTER DEFAULT PRIVILEGES FOR ROLE billing_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO billing_app;

-- Cover tables that already exist, for a re-run against a migrated database.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO billing_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO billing_app;
SQL

# --- verify ------------------------------------------------------------------
#
# Check the roles ended up as intended rather than trusting the commands above.
echo
echo "Verifying:"
psql -h "$DB_HOST" -d postgres -tAc \
  "SELECT '  '||rolname||': createdb='||rolcreatedb||' bypassrls='||rolbypassrls
     FROM pg_roles WHERE rolname IN ('billing_owner','billing_app') ORDER BY rolname;"

OWNER_OK=$(psql -h "$DB_HOST" -d postgres -tAc \
  "SELECT rolbypassrls FROM pg_roles WHERE rolname='billing_owner';" | tr -d ' ')
APP_BAD=$(psql -h "$DB_HOST" -d postgres -tAc \
  "SELECT rolbypassrls FROM pg_roles WHERE rolname='billing_app';" | tr -d ' ')

if [ "$OWNER_OK" != "t" ]; then
  echo "FAIL: billing_owner lacks BYPASSRLS; migrations would silently do nothing." >&2
  exit 1
fi
if [ "$APP_BAD" = "t" ]; then
  echo "FAIL: billing_app has BYPASSRLS; tenant isolation would not apply." >&2
  exit 1
fi

echo
echo "Done. Next:  pnpm db:migrate:deploy"
