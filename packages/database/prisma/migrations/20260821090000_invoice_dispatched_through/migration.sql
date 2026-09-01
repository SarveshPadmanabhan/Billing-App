-- How the goods were dispatched.
--
-- Free text: a carrier name, a vehicle registration, or "collected in person".
-- Deliberately not an enum — this is a note for the customer and for dispatch
-- records, and constraining it would mean editing the schema every time a new
-- courier is used.
--
-- Nullable, with no backfill. Invoices raised before this field existed have no
-- answer, and inventing one would put a delivery claim on a historical
-- financial document that nobody recorded.

ALTER TABLE invoices ADD COLUMN dispatched_through VARCHAR(255);
