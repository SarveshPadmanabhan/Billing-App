-- Link an invoice line to a stock item.
--
-- Nullable on purpose: services and ad-hoc lines are invoiced without touching
-- stock, and every existing invoice line predates stock entirely. RESTRICT
-- rather than CASCADE, matching the convention that financial history is never
-- destroyed by removing a parent.

ALTER TABLE invoice_items ADD COLUMN stock_item_id UUID;

ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_stock_item_id_fkey
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE RESTRICT;

CREATE INDEX invoice_items_stock_item_id_idx ON invoice_items (stock_item_id);
