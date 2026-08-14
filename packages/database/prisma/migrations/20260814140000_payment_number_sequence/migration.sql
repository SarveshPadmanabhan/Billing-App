-- ---------------------------------------------------------------------------
-- Payment numbering
--
-- Payments need a human-readable identifier with the same guarantees as
-- invoices and quotations: unique per organisation, race-safe under
-- concurrency, never reused. Rather than inventing a second scheme, this
-- extends document_sequences with a PAYMENT type so nextDocumentNumber() and
-- its concurrency guarantees (ADR-009) apply unchanged.
-- ---------------------------------------------------------------------------

ALTER TYPE document_number_type ADD VALUE IF NOT EXISTS 'PAYMENT';

ALTER TABLE organisation_settings
  ADD COLUMN IF NOT EXISTS payment_prefix VARCHAR(10) NOT NULL DEFAULT 'PAY-';

-- Back-fill a PAYMENT sequence for organisations that already exist.
--
-- Note the per-organisation loop with set_config. document_sequences has
-- FORCE ROW LEVEL SECURITY, so a plain INSERT ... SELECT across all
-- organisations silently inserts nothing — the WITH CHECK policy rejects every
-- row because no tenant context is set. Setting the context per organisation
-- is the only way to seed this table from a migration.
DO $$
DECLARE
  org RECORD;
BEGIN
  FOR org IN SELECT id FROM organisations LOOP
    PERFORM set_config('app.current_organisation_id', org.id::text, true);

    INSERT INTO document_sequences (
      id, organisation_id, document_type, prefix, padding, current_number, created_at, updated_at
    )
    SELECT
      gen_random_uuid(),
      org.id,
      'PAYMENT',
      COALESCE((SELECT payment_prefix FROM organisation_settings WHERE organisation_id = org.id), 'PAY-'),
      6,
      -- Seed past any payments already recorded, so the next number cannot
      -- collide with an existing one.
      (SELECT count(*) FROM payments WHERE organisation_id = org.id),
      now(), now()
    ON CONFLICT (organisation_id, document_type) DO NOTHING;
  END LOOP;

  PERFORM set_config('app.current_organisation_id', '', true);
END;
$$;
