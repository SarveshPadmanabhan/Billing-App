-- Currently selected company on the session.
--
-- Server-controlled like active_organisation_id: written only by the
-- switch-company endpoint after the company is confirmed to belong to the
-- session's organisation. Null means "use the organisation's default company",
-- which is what every existing session gets.
--
-- sessions is not a tenant table (it is keyed by user, not organisation) and
-- carries no RLS policy, so no backfill loop is needed here.

ALTER TABLE sessions ADD COLUMN active_company_id UUID;
