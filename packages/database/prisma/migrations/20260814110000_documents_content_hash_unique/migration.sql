-- ---------------------------------------------------------------------------
-- Documents: content hash + uniqueness for safe concurrent PDF generation
--
-- Two changes, both serving generated-document caching:
--
-- 1. content_hash — the cache key. It is a hash of everything the rendered
--    PDF actually displays (totals, status, line items, customer snapshot,
--    organisation branding). Deliberately NOT updated_at: that changes on
--    writes which do not affect the PDF (an internal note) and misses changes
--    that do (a payment landing alters the status badge and balance through a
--    different row).
--
-- 2. A unique index on (organisation_id, entity_id, document_type, version).
--    Two simultaneous requests for an uncached document both render, but only
--    one row can be inserted; the loser resolves to the winner's row instead
--    of creating a duplicate. Wasteful under a rare race, never incorrect.
--    A request-level lock or debounce is a future option if duplicate renders
--    ever show up as a real cost — not warranted at MVP volumes.
-- ---------------------------------------------------------------------------

ALTER TABLE documents ADD COLUMN content_hash VARCHAR(64);

CREATE UNIQUE INDEX documents_organisation_id_entity_id_document_type_version_key
  ON documents (organisation_id, entity_id, document_type, version);

-- Supports the cache lookup: "is there already a document for this entity at
-- this exact content hash?"
CREATE INDEX documents_organisation_id_entity_id_content_hash_idx
  ON documents (organisation_id, entity_id, content_hash);
