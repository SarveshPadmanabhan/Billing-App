-- ---------------------------------------------------------------------------
-- Correct the RLS model for organisation_members.
--
-- The previous migration scoped organisation_members by
-- current_organisation_id(), which is wrong in a subtle and important way:
-- this table is the mapping FROM a user TO their organisations, so it is read
-- *before* any tenant context exists — that read is what establishes the
-- context. Under the old policy the row was invisible exactly when needed, and
-- every request failed with "not an active member" despite valid membership.
--
-- Correct model: organisation_members is a membership directory keyed by user,
-- not tenant-owned data. It is scoped by the *user*, with the organisation
-- scope kept as an additional allowed path for in-tenant member listings.
--
-- The API sets app.current_user_id alongside app.current_organisation_id.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_user_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  raw TEXT;
BEGIN
  raw := current_setting('app.current_user_id', true);
  IF raw IS NULL OR raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$;

DROP POLICY IF EXISTS tenant_isolation ON organisation_members;

-- A row is visible when EITHER:
--   (a) it is this user's own membership — the bootstrap read that resolves
--       tenant context and powers the organisation switcher; or
--   (b) it belongs to the active organisation — listing colleagues, which the
--       API additionally gates behind the user:manage permission.
--
-- Both arms fail closed: with neither setting present, current_user_id() and
-- current_organisation_id() are NULL and no row matches.
CREATE POLICY membership_visibility ON organisation_members
  USING (
    user_id = current_user_id()
    OR organisation_id = current_organisation_id()
  );

-- Writes stay strictly tenant-scoped: a user must never be able to insert or
-- alter a membership outside the active organisation (which would be a
-- privilege-escalation path into another tenant).
CREATE POLICY membership_write ON organisation_members
  FOR INSERT
  WITH CHECK (organisation_id = current_organisation_id());

CREATE POLICY membership_update ON organisation_members
  FOR UPDATE
  USING (organisation_id = current_organisation_id())
  WITH CHECK (organisation_id = current_organisation_id());

CREATE POLICY membership_delete ON organisation_members
  FOR DELETE
  USING (organisation_id = current_organisation_id());

-- ---------------------------------------------------------------------------
-- organisations: same bootstrap problem, same shape of fix.
--
-- The organisation switcher must list the organisations a user belongs to
-- before one is selected. Reading is allowed for organisations the user is a
-- member of; writing remains restricted to the active organisation.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation ON organisations;

CREATE POLICY organisation_visibility ON organisations
  FOR SELECT
  USING (
    id = current_organisation_id()
    OR EXISTS (
      SELECT 1 FROM organisation_members m
       WHERE m.organisation_id = organisations.id
         AND m.user_id = current_user_id()
         AND m.is_active
    )
  );

CREATE POLICY organisation_insert ON organisations
  FOR INSERT
  WITH CHECK (id = current_organisation_id());

CREATE POLICY organisation_update ON organisations
  FOR UPDATE
  USING (id = current_organisation_id())
  WITH CHECK (id = current_organisation_id());

CREATE POLICY organisation_delete ON organisations
  FOR DELETE
  USING (id = current_organisation_id());
