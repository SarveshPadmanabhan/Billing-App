-- UPI ID (VPA) a company collects payments into.
--
-- Per company rather than per organisation: companies are separate legal
-- entities that generally bank separately, so one shared ID would route a
-- customer's payment to the wrong entity.
--
-- Nullable with no default. There is no safe value to invent here — a wrong
-- UPI ID sends real money to the wrong account, so an unset one simply means
-- no payment QR is printed.

ALTER TABLE companies ADD COLUMN upi_id VARCHAR(255);
