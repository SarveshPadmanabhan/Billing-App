# ADR-008: Authentication via Better Auth

## Status
Accepted — Phase 1.

## Context
The source documents conflict.

- Technical Architecture Document §8 puts `password_hash TEXT` on `users` and
  §13 specifies Argon2id — i.e. self-hosted credential storage.
- Security & Access Document §2 says to "use a mature managed authentication
  provider rather than building password security ... from scratch".
- Frontend Specification §25 says "Do not duplicate password storage in the
  application's own database."

These cannot all hold. A managed provider (Clerk, Auth0, Supabase Auth) would
satisfy the Security Document but adds a third-party account, network
dependency, and per-seat cost, and makes offline testing of TICKET-003/004
awkward.

## Decision
Use **Better Auth** — a TypeScript-native authentication library running
entirely against our own PostgreSQL.

It provides password hashing (scrypt), session issuance and rotation, email
verification, password reset, and optional MFA: the parts the Security Document
warns against hand-rolling. It requires no third-party signup or network call.

Consequences for the schema:
- `users.password_hash` is **removed**. Credentials live in Better Auth's
  `accounts` table.
- The `refresh_tokens` table from Tech Arch §8 is **replaced** by Better Auth's
  `sessions` table, which serves the same purpose (expiry, revocation, stored
  hashes, user-agent/IP) with a maintained implementation.

Authorization is explicitly **not** delegated. Better Auth answers "who are
you?"; organisation membership and RBAC are enforced by this application, as
the Security Document §2 requires.

## Alternatives
- **Clerk / Auth0** — best-in-class, but a paid external dependency and an
  extra failure mode for a self-contained MVP.
- **Supabase Auth** — self-hostable, but pulls in the wider Supabase stack.
- **Hand-rolled Argon2id + JWT** — matches the Tech Arch Document literally,
  but is precisely what the Security Document advises against, and puts session
  rotation, reset-token single-use, and MFA on us.

## Consequences
- Password hashing is scrypt, not Argon2id as Tech Arch §13 states. Both are
  memory-hard and appropriate; Better Auth's default is used rather than
  configuring a custom hasher. **Flag for review** if Argon2id is a compliance
  requirement rather than a preference.
- A future migration to a managed provider means migrating the `accounts`
  table, not rewriting authorization.
- `session.activeOrganisationId` is a custom field declared with `input: false`
  so it is server-writable only — the client cannot set its own tenant context.
