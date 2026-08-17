-- Companies within an organisation.
--
-- The organisation remains the tenant boundary: RLS, membership and every
-- isolation guarantee still key off organisation_id. A company is a division
-- *inside* that boundary — several legal entities under one account, each with
-- its own invoice numbering and financial position.
--
-- Company is NOT a security boundary. Members of an organisation can see every
-- company in it; scoping by company filters the view, it does not isolate
-- tenants. RLS policies below therefore stay on organisation_id.

CREATE TABLE companies (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name             VARCHAR(255) NOT NULL,
  legal_name       VARCHAR(255),
  logo_url         TEXT,
  email            VARCHAR(255),
  phone            VARCHAR(30),
  address_line_1   VARCHAR(255),
  address_line_2   VARCHAR(255),
  city             VARCHAR(100),
  state            VARCHAR(100),
  postal_code      VARCHAR(30),
  country_code     CHAR(2) NOT NULL DEFAULT 'IN',
  tax_number       VARCHAR(100),
  currency_code    CHAR(3) NOT NULL DEFAULT 'INR',
  invoice_prefix   VARCHAR(10) NOT NULL DEFAULT 'INV-',
  quotation_prefix VARCHAR(10) NOT NULL DEFAULT 'QUO-',
  payment_prefix   VARCHAR(10) NOT NULL DEFAULT 'PAY-',
  is_default       BOOLEAN NOT NULL DEFAULT false,
  is_archived      BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX companies_organisation_id_idx ON companies (organisation_id);
CREATE INDEX companies_organisation_id_is_archived_idx ON companies (organisation_id, is_archived);

-- Exactly one default per organisation. A partial unique index expresses this
-- directly rather than relying on application code to keep it true.
CREATE UNIQUE INDEX companies_one_default_per_org
  ON companies (organisation_id) WHERE is_default;

-- --------------------------------------------------------------------------
-- Backfill: one company per existing organisation, inheriting its details.
--
-- --------------------------------------------------------------------------

-- This migration requires BYPASSRLS on the migration role (billing_owner).
-- Without it every read here returns zero rows: FORCE ROW LEVEL SECURITY
-- applies to the table owner too, so a data migration cannot see the data it
-- is migrating. The prior payment_number_sequence migration hit this and
-- silently under-filled — it created sequences for only 217 of 237
-- organisations and nobody noticed, because a loop over zero rows looks
-- exactly like success.
--
-- Guard it explicitly rather than assume: refuse to run rather than pass.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION
      'migration role % lacks BYPASSRLS; this data migration would silently '
      'affect zero rows. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END;
$$;

DO $$
DECLARE
  created INT;
  org_total INT;
BEGIN
  SELECT count(*) INTO org_total FROM organisations;

  -- Refuse on an implausible zero: an empty organisations table means either a
  -- genuinely empty database or an RLS filter, and the two are
  -- indistinguishable from a row count alone.
  IF org_total = 0 THEN
    RAISE EXCEPTION 'no organisations visible; refusing to run a backfill that would do nothing';
  END IF;

  INSERT INTO companies (
    organisation_id, name, legal_name, logo_url, email, phone,
    address_line_1, address_line_2, city, state, postal_code,
    country_code, tax_number, currency_code, is_default
  )
  SELECT id, name, legal_name, logo_url, email, phone,
         address_line_1, address_line_2, city, state, postal_code,
         country_code, tax_number, currency_code, true
  FROM organisations;

  GET DIAGNOSTICS created = ROW_COUNT;
  RAISE NOTICE 'companies backfill: created % company/companies for % organisation(s)', created, org_total;

  IF created <> org_total THEN
    RAISE EXCEPTION 'backfill created % companies for % organisations', created, org_total;
  END IF;
END;
$$;

-- --------------------------------------------------------------------------
-- company_id on owned tables. Added nullable, backfilled, then made NOT NULL —
-- adding NOT NULL directly would fail against existing rows.
-- --------------------------------------------------------------------------

ALTER TABLE customers          ADD COLUMN company_id UUID;
ALTER TABLE quotations         ADD COLUMN company_id UUID;
ALTER TABLE invoices           ADD COLUMN company_id UUID;
ALTER TABLE payments           ADD COLUMN company_id UUID;
ALTER TABLE documents          ADD COLUMN company_id UUID;
ALTER TABLE document_sequences ADD COLUMN company_id UUID;

DO $$
DECLARE
  t TEXT;
  remaining BIGINT;
  filled BIGINT;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers','quotations','invoices','payments','documents','document_sequences']
  LOOP
    EXECUTE format(
      'UPDATE %I t SET company_id = c.id FROM companies c
        WHERE c.organisation_id = t.organisation_id AND c.is_default',
      t
    );
    GET DIAGNOSTICS filled = ROW_COUNT;

    EXECUTE format('SELECT count(*) FROM %I WHERE company_id IS NULL', t) INTO remaining;
    RAISE NOTICE 'backfilled %: % row(s) assigned, % still null', t, filled, remaining;

    IF remaining > 0 THEN
      RAISE EXCEPTION '% has % row(s) with no company after backfill', t, remaining;
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE customers          ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE quotations         ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE invoices           ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE payments           ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE documents          ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE document_sequences ALTER COLUMN company_id SET NOT NULL;

-- Restrict, matching the existing convention: financial history is never
-- destroyed by deleting a parent. Archive a company instead.
ALTER TABLE customers          ADD CONSTRAINT customers_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE quotations         ADD CONSTRAINT quotations_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE invoices           ADD CONSTRAINT invoices_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE payments           ADD CONSTRAINT payments_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE documents          ADD CONSTRAINT documents_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE document_sequences ADD CONSTRAINT document_sequences_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;

CREATE INDEX customers_organisation_id_company_id_idx  ON customers (organisation_id, company_id);
CREATE INDEX quotations_organisation_id_company_id_idx ON quotations (organisation_id, company_id);
CREATE INDEX invoices_organisation_id_company_id_idx   ON invoices (organisation_id, company_id);
CREATE INDEX payments_organisation_id_company_id_idx   ON payments (organisation_id, company_id);
CREATE INDEX documents_organisation_id_company_id_idx  ON documents (organisation_id, company_id);

-- --------------------------------------------------------------------------
-- Numbering moves from per-organisation to per-company.
--
-- Document numbers are minted from document_sequences, so if the sequence is
-- per company the uniqueness constraint must be too. Left at organisation
-- scope, a second company would mint INV-000001 and collide with the first.
-- --------------------------------------------------------------------------

ALTER TABLE document_sequences DROP CONSTRAINT IF EXISTS document_sequences_organisation_id_document_type_key;
CREATE UNIQUE INDEX document_sequences_company_id_document_type_key
  ON document_sequences (company_id, document_type);

ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_organisation_id_quotation_number_key;
CREATE UNIQUE INDEX quotations_company_id_quotation_number_key
  ON quotations (company_id, quotation_number);

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_organisation_id_invoice_number_key;
CREATE UNIQUE INDEX invoices_company_id_invoice_number_key
  ON invoices (company_id, invoice_number);

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_organisation_id_payment_number_key;
CREATE UNIQUE INDEX payments_company_id_payment_number_key
  ON payments (company_id, payment_number);

-- --------------------------------------------------------------------------
-- RLS on the new table. Same organisation_id policy as every other tenant
-- table: a company is visible to its organisation and to no one else.
-- --------------------------------------------------------------------------

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON companies
  USING (organisation_id = current_organisation_id())
  WITH CHECK (organisation_id = current_organisation_id());
