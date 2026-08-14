# ADR-004: Multi-tenant isolation model

## Status
Accepted — Phase 1.

## Context
The central security requirement: no organisation may reach another's data,
including by guessing or reusing a UUID.

## Decision
Three layers, in order of primacy.

**1. Application authorization (primary).**
`OrganisationGuard` derives tenant context solely from `session.activeOrganisationId`,
a column only the server writes, and re-reads `organisation_members` on every
request so role changes and removals take effect immediately.

Any client-supplied organisation id — header, path, query, or body — that
disagrees with the session is rejected with 403. It is treated as an attack,
not silently ignored, so probing is visible in logs.

**2. Query-level scoping.**
Every tenant query filters on `organisationId` explicitly, keeping the index in
play and not relying on RLS alone.

**3. PostgreSQL RLS (defence-in-depth).**
`app.current_organisation_id` is set per transaction via `set_config(..., true)`
— transaction-local, so it is discarded on commit/rollback and cannot leak
across pooled connections. Policies fail closed: with no context, zero rows.

## Important correction made during implementation
`organisation_members` and `organisations` were initially scoped by
`current_organisation_id()` like every other tenant table. This is wrong: those
tables are read *before* tenant context exists — that read is what establishes
the context. Under the original policy the membership row was invisible exactly
when needed, and every authenticated request failed with "not an active member".

They are now scoped by `current_user_id()` for reads (a user sees their own
memberships and the organisations they belong to) while **writes** remain
restricted to the active organisation, so a user cannot insert a membership
into another tenant. See migration `20260813172000_fix_membership_rls`.

The lesson generalises: bootstrap tables in a multi-tenant system cannot be
scoped by the very context they establish.

## Consequences
- Cross-tenant access returns **404, not 403** — a 403 confirms existence and
  creates an enumeration oracle (Security Doc §23).
- `users`, `sessions`, `accounts`, `verifications` are deliberately outside RLS:
  they are global, and login must resolve a user before any tenant is known.
  Documented rather than left as an oversight.
- Child tables (`quotation_items`, `invoice_items`, `payment_allocations`) have
  no `organisation_id` of their own, per the Tech Arch field list, so they are
  constrained through an `EXISTS` on their RLS-protected parent.
