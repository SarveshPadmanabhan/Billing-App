-- Low-stock threshold becomes 25.
--
-- The item form no longer collects a reorder level, so this default is the
-- threshold every item gets. At the previous default of 0 an item only read as
-- "low" once it was already out of stock — a warning that arrives too late to
-- act on.
--
-- Existing items are updated too, which is a deliberate data change: with no
-- way to set the value per item, leaving old rows on their original thresholds
-- would mean two items behaving differently with nothing in the UI explaining
-- why. This is a display threshold, not a financial figure — it changes when a
-- warning appears, never a quantity, a price or a total.

ALTER TABLE stock_items ALTER COLUMN reorder_level SET DEFAULT 25;

DO $$
DECLARE
  updated INT;
  total INT;
BEGIN
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION
      'migration role % lacks BYPASSRLS; this update would silently affect '
      'zero rows. Run: ALTER ROLE % BYPASSRLS;', current_user, current_user;
  END IF;

  SELECT count(*) INTO total FROM stock_items;

  UPDATE stock_items SET reorder_level = 25;
  GET DIAGNOSTICS updated = ROW_COUNT;

  RAISE NOTICE 'reorder level set to 25 on % of % stock item(s)', updated, total;

  -- A row count that disagrees with the table size means the UPDATE was
  -- filtered — the silent-no-op failure mode this project has hit before.
  IF updated <> total THEN
    RAISE EXCEPTION 'updated % rows but the table holds %', updated, total;
  END IF;
END;
$$;
