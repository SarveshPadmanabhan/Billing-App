-- Link a quotation line to a stock item.
--
-- Needed so the link survives quotation -> invoice conversion. Without it a
-- converted invoice would lose its stock reference and silently stop
-- deducting, which is worse than never having linked it: the stock would look
-- correct while the goods had left.

ALTER TABLE quotation_items ADD COLUMN stock_item_id UUID;

ALTER TABLE quotation_items ADD CONSTRAINT quotation_items_stock_item_id_fkey
  FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE RESTRICT;

CREATE INDEX quotation_items_stock_item_id_idx ON quotation_items (stock_item_id);
