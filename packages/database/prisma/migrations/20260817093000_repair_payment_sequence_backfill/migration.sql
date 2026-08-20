-- Repair the PAYMENT sequence backfill that silently under-filled.
--
-- The 20260814140000_payment_number_sequence migration looped over
-- `SELECT id FROM organisations` to create one PAYMENT sequence per
-- organisation. It ran as billing_owner, which had no BYPASSRLS, so under
-- FORCE ROW LEVEL SECURITY that SELECT returned zero rows for organisations
-- whose context was never set. It reported success having created sequences
-- for 217 of 237 organisations.
--
-- Nothing broke visibly: the application creates a missing sequence lazily on
-- first payment. But the migration did not do what its log claimed, and the
-- drift would have grown with every future data migration written the same way.
--
-- This repair runs after companies exist, so sequences are keyed by company.

DO $$
BEGIN
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION
      'migration role % lacks BYPASSRLS; this repair would silently fix '
      'nothing. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;
END;
$$;

DO $$
DECLARE
  company_total INT;
  created INT;
  missing INT;
BEGIN
  SELECT count(*) INTO company_total FROM companies;
  -- As above: no companies on a fresh database is correct, not a filtered
  -- read. BYPASSRLS has already been verified.
  IF company_total = 0 THEN
    RAISE NOTICE 'no companies yet; nothing to repair (fresh database)';
    RETURN;
  END IF;

  -- One sequence per company per document type. current_number is seeded past
  -- any documents that already exist so a repaired sequence cannot mint a
  -- number that collides with one already issued.
  INSERT INTO document_sequences (
    id, organisation_id, company_id, document_type, prefix, padding,
    current_number, created_at, updated_at
  )
  SELECT
    gen_random_uuid(),
    c.organisation_id,
    c.id,
    t.document_type,
    CASE t.document_type
      WHEN 'INVOICE'   THEN c.invoice_prefix
      WHEN 'QUOTATION' THEN c.quotation_prefix
      ELSE c.payment_prefix
    END,
    6,
    CASE t.document_type
      WHEN 'INVOICE'   THEN (SELECT count(*) FROM invoices   i WHERE i.company_id = c.id)
      WHEN 'QUOTATION' THEN (SELECT count(*) FROM quotations q WHERE q.company_id = c.id)
      ELSE                  (SELECT count(*) FROM payments   p WHERE p.company_id = c.id)
    END,
    now(), now()
  FROM companies c
  CROSS JOIN (VALUES ('INVOICE'::document_number_type),
                     ('QUOTATION'::document_number_type),
                     ('PAYMENT'::document_number_type)) AS t(document_type)
  WHERE NOT EXISTS (
    SELECT 1 FROM document_sequences ds
    WHERE ds.company_id = c.id AND ds.document_type = t.document_type
  );

  GET DIAGNOSTICS created = ROW_COUNT;
  RAISE NOTICE 'repaired % missing sequence(s)', created;

  -- Every company must now have all three. Verified explicitly rather than
  -- inferred from the insert count.
  SELECT count(*) INTO missing
  FROM companies c
  CROSS JOIN (VALUES ('INVOICE'::document_number_type),
                     ('QUOTATION'::document_number_type),
                     ('PAYMENT'::document_number_type)) AS t(document_type)
  WHERE NOT EXISTS (
    SELECT 1 FROM document_sequences ds
    WHERE ds.company_id = c.id AND ds.document_type = t.document_type
  );

  IF missing > 0 THEN
    RAISE EXCEPTION '% company/document-type pair(s) still have no sequence', missing;
  END IF;

  RAISE NOTICE 'all % companies have all three sequences', company_total;
END;
$$;
