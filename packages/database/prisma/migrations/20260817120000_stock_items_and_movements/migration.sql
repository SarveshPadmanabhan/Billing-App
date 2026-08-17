-- Stock items and movements, scoped to a company.
--
-- quantity_on_hand is stored for query speed but is DERIVED: it is recomputed
-- from stock_movements on every change, never incremented in place. That is
-- ADR-009's ledger principle applied to stock — the movements are the truth,
-- the column is a cache of them, and integrity.sh checks the two agree.
--
-- Movements are append-only. A correction is a new ADJUSTMENT row, never an
-- edit, so the history of how a quantity was reached stays auditable.

CREATE TYPE stock_movement_type AS ENUM ('IN', 'OUT', 'ADJUSTMENT');

CREATE TABLE stock_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  sku              VARCHAR(64) NOT NULL,
  name             VARCHAR(255) NOT NULL,
  description      TEXT,
  unit             VARCHAR(20) NOT NULL DEFAULT 'unit',
  unit_price       NUMERIC(19,4) NOT NULL DEFAULT 0,
  quantity_on_hand NUMERIC(19,4) NOT NULL DEFAULT 0,
  reorder_level    NUMERIC(19,4) NOT NULL DEFAULT 0,
  tracks_stock     BOOLEAN NOT NULL DEFAULT true,
  is_archived      BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- SKUs identify an item within its company; two companies may reuse one.
CREATE UNIQUE INDEX stock_items_company_id_sku_key ON stock_items (company_id, sku);
CREATE INDEX stock_items_organisation_id_company_id_idx ON stock_items (organisation_id, company_id);
CREATE INDEX stock_items_org_company_archived_idx ON stock_items (organisation_id, company_id, is_archived);

CREATE TABLE stock_movements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  stock_item_id   UUID NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  movement_type   stock_movement_type NOT NULL,
  -- Always positive: direction is carried by movement_type, so a signed
  -- quantity can never disagree with the type it is stored against.
  quantity        NUMERIC(19,4) NOT NULL CHECK (quantity > 0),
  invoice_id      UUID REFERENCES invoices(id) ON DELETE RESTRICT,
  reason          VARCHAR(255),
  created_by      UUID,
  created_at      TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX stock_movements_organisation_id_company_id_idx ON stock_movements (organisation_id, company_id);
CREATE INDEX stock_movements_stock_item_id_idx ON stock_movements (stock_item_id);
CREATE INDEX stock_movements_invoice_id_idx ON stock_movements (invoice_id);

-- An invoice must deduct a given item at most once, so a retried send cannot
-- double-deduct. This is the database backstop behind the application's
-- lock-and-recheck, not a replacement for it (ADR-009).
CREATE UNIQUE INDEX stock_movements_invoice_item_unique
  ON stock_movements (invoice_id, stock_item_id)
  WHERE invoice_id IS NOT NULL AND movement_type = 'OUT';

-- Same RLS treatment as every other tenant table: the organisation is the
-- boundary, company only scopes the view.
ALTER TABLE stock_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_items
  USING (organisation_id = current_organisation_id())
  WITH CHECK (organisation_id = current_organisation_id());

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_movements
  USING (organisation_id = current_organisation_id())
  WITH CHECK (organisation_id = current_organisation_id());

-- Movements are append-only. Blocking UPDATE and DELETE at the database means
-- a bug or a careless script cannot rewrite stock history; a correction has to
-- be a new ADJUSTMENT row, which leaves the original visible.
CREATE RULE stock_movements_no_update AS ON UPDATE TO stock_movements DO INSTEAD NOTHING;
CREATE RULE stock_movements_no_delete AS ON DELETE TO stock_movements DO INSTEAD NOTHING;
