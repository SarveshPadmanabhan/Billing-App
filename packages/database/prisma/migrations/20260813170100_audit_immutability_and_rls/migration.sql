-- ---------------------------------------------------------------------------
-- Audit-log immutability + Row-Level Security
--
-- Two guarantees Prisma's schema language cannot express:
--   1. audit_logs is append-only (Security Doc §21).
--   2. Tenant isolation is enforced by the database itself, so an application
--      bug that forgets a WHERE organisation_id = ... still cannot leak rows
--      across tenants (Security Doc §14, TICKET-007).
--
-- RLS here is defence-in-depth. The NestJS guard remains the primary control.
-- ---------------------------------------------------------------------------

-- --- 1. Append-only audit log ----------------------------------------------

CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

-- --- 2. Tenant context helper ----------------------------------------------
-- The API sets `app.current_organisation_id` per transaction via
-- set_config(...). Absent or malformed, this returns NULL and every tenant
-- policy below evaluates false — i.e. fail closed, denying all rows.

CREATE OR REPLACE FUNCTION current_organisation_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  raw TEXT;
BEGIN
  raw := current_setting('app.current_organisation_id', true);
  IF raw IS NULL OR raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  -- A forged, non-UUID value must not error the query into a fallback path;
  -- it must simply match nothing.
  RETURN NULL;
END;
$$;

-- --- 3. RLS on tenant-owned tables -----------------------------------------
-- FORCE applies the policy to the table owner too, so migrations run as
-- billing_owner cannot silently bypass it at runtime.

DO $$
DECLARE
  tenant_table TEXT;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'organisations',
    'organisation_settings',
    'organisation_members',
    'document_sequences',
    'customers',
    'quotations',
    'invoices',
    'payments',
    'documents',
    'notifications',
    'audit_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
  END LOOP;
END;
$$;

-- organisations keys on `id`; every other tenant table on `organisation_id`.
CREATE POLICY tenant_isolation ON organisations
  USING (id = current_organisation_id())
  WITH CHECK (id = current_organisation_id());

DO $$
DECLARE
  tenant_table TEXT;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'organisation_settings',
    'organisation_members',
    'document_sequences',
    'customers',
    'quotations',
    'invoices',
    'payments',
    'documents',
    'notifications'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (organisation_id = current_organisation_id())
         WITH CHECK (organisation_id = current_organisation_id())',
      tenant_table
    );
  END LOOP;
END;
$$;

-- audit_logs: readable only within the tenant, but INSERT must also accept
-- rows with a NULL organisation_id — a failed login has no org context yet.
CREATE POLICY tenant_isolation_select ON audit_logs
  FOR SELECT
  USING (organisation_id = current_organisation_id());

CREATE POLICY tenant_isolation_insert ON audit_logs
  FOR INSERT
  WITH CHECK (
    organisation_id IS NULL
    OR organisation_id = current_organisation_id()
  );

-- --- 4. Child tables inherit isolation via their parent ---------------------
-- quotation_items / invoice_items / payment_allocations have no
-- organisation_id of their own (per the architecture doc's field list), so
-- they are constrained through an EXISTS on the parent, which is itself
-- RLS-protected.

ALTER TABLE quotation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotation_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON quotation_items
  USING (EXISTS (SELECT 1 FROM quotations q WHERE q.id = quotation_id))
  WITH CHECK (EXISTS (SELECT 1 FROM quotations q WHERE q.id = quotation_id));

ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_items
  USING (EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id))
  WITH CHECK (EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_id));

ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_allocations
  USING (EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id))
  WITH CHECK (EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id));

-- --- 5. Identity tables stay outside RLS ------------------------------------
-- users / sessions / accounts / verifications are global, not tenant-owned:
-- one user may belong to several organisations, and login must resolve a user
-- before any organisation context exists. They are protected by application
-- authorization only. Documented deliberately rather than left as an oversight.

-- --- 6. Runtime grants ------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO billing_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO billing_app;

-- audit_logs is append-only for the runtime role as well; the triggers above
-- are belt-and-braces behind this grant restriction.
REVOKE UPDATE, DELETE ON audit_logs FROM billing_app;
