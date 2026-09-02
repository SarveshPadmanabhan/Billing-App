-- Close the Better Auth tables to Supabase's public API.
--
-- Supabase exposes every table in `public` through PostgREST, reachable with
-- the anon key — which is designed to be published in a browser. These five
-- tables were created by earlier migrations without RLS, because the
-- application reaches them through Prisma as billing_app and never through
-- PostgREST.
--
-- On Supabase that assumption is false. Verified before this migration: the
-- anon key could read every row of `users` and the scrypt password hashes in
-- `accounts` over plain HTTPS, unauthenticated.
--
-- Two layers, deliberately:
--   1. RLS with a policy granting only billing_app. Enabling RLS alone denies
--      everyone — including the application — which broke sign-in when tried.
--   2. REVOKE from anon and authenticated, so access does not rest on policy
--      correctness alone.
--
-- No tenant predicate here: these tables are not organisation-scoped. Better
-- Auth must read any user's row to authenticate them at all.

ALTER TABLE public.users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verifications      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._prisma_migrations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'billing_app') THEN
    CREATE POLICY app_full_access ON public.users
      FOR ALL TO billing_app USING (true) WITH CHECK (true);
    CREATE POLICY app_full_access ON public.sessions
      FOR ALL TO billing_app USING (true) WITH CHECK (true);
    CREATE POLICY app_full_access ON public.accounts
      FOR ALL TO billing_app USING (true) WITH CHECK (true);
    CREATE POLICY app_full_access ON public.verifications
      FOR ALL TO billing_app USING (true) WITH CHECK (true);
  ELSE
    RAISE NOTICE 'billing_app absent; skipping policies (local dev without that role)';
  END IF;

  -- anon/authenticated exist only on Supabase.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.users, public.sessions, public.accounts,
                  public.verifications, public._prisma_migrations
      FROM anon, authenticated;
  END IF;
END
$$;
