-- Drop the organisation-scoped uniqueness that numbering has outgrown.
--
-- The companies migration moved numbering to (company_id, document_type) and
-- attempted to remove the old pair with DROP CONSTRAINT IF EXISTS. That was a
-- no-op: Prisma had created these as unique *indexes*, not table constraints,
-- so IF EXISTS matched nothing and reported success. The old index survived.
--
-- Effect while it survived: a second company in an organisation could not get
-- its own sequences. document_sequences.createMany runs with
-- skipDuplicates: true, so the insert was silently skipped rather than
-- rejected, the endpoint returned 201, and the failure only surfaced later as
-- "No INVOICE sequence" when the company tried to issue its first document.
--
-- The same applies to the document-number uniqueness on the three document
-- tables: numbers are minted per company, so two companies would both mint
-- INV-000001 and collide under an organisation-scoped index.

DROP INDEX IF EXISTS document_sequences_organisation_id_document_type_key;
DROP INDEX IF EXISTS quotations_organisation_id_quotation_number_key;
DROP INDEX IF EXISTS invoices_organisation_id_invoice_number_key;
DROP INDEX IF EXISTS payments_organisation_id_payment_number_key;

-- Confirm the company-scoped replacements are actually in place. Dropping the
-- old guarantee without the new one leaves numbering unprotected.
DO $$
DECLARE
  missing TEXT[];
  idx TEXT;
BEGIN
  FOREACH idx IN ARRAY ARRAY[
    'document_sequences_company_id_document_type_key',
    'quotations_company_id_quotation_number_key',
    'invoices_company_id_invoice_number_key',
    'payments_company_id_payment_number_key'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = idx) THEN
      missing := array_append(missing, idx);
    END IF;
  END LOOP;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'company-scoped unique index(es) missing: %', array_to_string(missing, ', ');
  END IF;

  RAISE NOTICE 'all four company-scoped unique indexes present';
END;
$$;
