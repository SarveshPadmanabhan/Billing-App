-- Create the runtime role on a Supabase project.
--
-- Run this ONCE, before the migrations, with a password of your choosing:
--   psql "$DATABASE_MIGRATION_URL" -v app_password="'your-strong-password'" \
--        -f scripts/setup-supabase.sql
--
-- Why this exists: Supabase's built-in `postgres` role has BYPASSRLS. That is
-- correct for migrations, and fatal for the application. If the app connected
-- as `postgres`, row-level security would not apply to it and every tenant
-- would see every other tenant's data — with no error to reveal it.
--
-- So the same two-role split used locally is preserved:
--   postgres    — migrations only. Has BYPASSRLS (Supabase grants it).
--   billing_app — the application. Must NOT have BYPASSRLS.

\set ON_ERROR_STOP on

-- psql variables are NOT substituted inside a dollar-quoted DO block, so the
-- role is created with plain statements and \gexec instead.
SELECT format('CREATE ROLE billing_app LOGIN PASSWORD %L', :app_password)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'billing_app')
\gexec

SELECT format('ALTER ROLE billing_app LOGIN PASSWORD %L', :app_password)
 WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'billing_app')
\gexec

-- Stated explicitly rather than relying on the default. This single attribute
-- is what keeps tenant isolation switched on.
ALTER ROLE billing_app NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO billing_app;

-- Cover both what exists now and what the migrations create afterwards.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO billing_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO billing_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO billing_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO billing_app;

-- Verify rather than assume. A billing_app that somehow held BYPASSRLS would
-- pass every test while leaking across tenants, so refuse to finish.
DO $$
DECLARE
  bypass BOOLEAN;
BEGIN
  SELECT rolbypassrls INTO bypass FROM pg_roles WHERE rolname = 'billing_app';
  IF bypass THEN
    RAISE EXCEPTION 'billing_app has BYPASSRLS; tenant isolation would not apply';
  END IF;
  RAISE NOTICE 'billing_app is correctly NOBYPASSRLS';
END
$$;
