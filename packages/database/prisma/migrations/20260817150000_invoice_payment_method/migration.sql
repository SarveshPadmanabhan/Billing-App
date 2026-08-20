-- How an invoice is to be paid.
--
-- Reuses the existing payment_method enum rather than defining a parallel one,
-- so the expected method on an invoice and the actual method on a recorded
-- payment are directly comparable.
--
-- Nullable in the database on purpose. Invoices created before this field
-- exists have no answer, and defaulting them to CASH or BANK_TRANSFER would be
-- fabricating a financial detail nobody recorded. New invoices are required to
-- supply it at the API boundary, which is where the requirement belongs: the
-- rule applies to what is created from now on, not retroactively to history.

ALTER TABLE invoices ADD COLUMN payment_method payment_method;
