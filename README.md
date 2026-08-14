# Billing Platform

Multi-tenant SaaS for organisation billing: customers, quotations, invoices,
payments, PDFs and reporting.

This is a financial application. Data integrity, tenant isolation and
auditability take precedence over delivery speed.

**Status: Phase 1 (Foundation) complete — TICKET-001 through TICKET-008.**

---

## Requirements

| Tool       | Version | Notes                              |
| ---------- | ------- | ---------------------------------- |
| Node.js    | ≥ 20.11 | Developed against v24              |
| pnpm       | ≥ 9     | Workspace manager                  |
| PostgreSQL | 16      | RLS and `NUMERIC(19,4)` are load-bearing |
| Redis      | ≥ 7     | BullMQ job queues                  |

## Setup from a fresh clone

### 1. Install services

macOS (Homebrew):

```bash
brew install postgresql@16 redis
brew services start postgresql@16
brew services start redis
```

> **Redis 8.10 on macOS — known bottle bug.** The Homebrew bottle ships a
> `redis.conf` whose final section has four `loadmodule` lines for
> `redisbloom`, `redisearch`, `redisjson` and `redistimeseries`. Those modules
> are **not** included in the bottle, and Redis aborts on startup when a
> `loadmodule` target is missing — so `brew services start redis` reports
> success while the server is actually dead, and `redis-cli ping` fails with
> "connection refused".
>
> Fix (already applied on this machine, repeat it on a fresh setup):
>
> ```bash
> cp /opt/homebrew/etc/redis.conf /opt/homebrew/etc/redis.conf.bak
> sed -i '' 's|^loadmodule \./modules/|# disabled: not shipped in bottle — loadmodule ./modules/|' \
>   /opt/homebrew/etc/redis.conf
> brew services restart redis
> redis-cli ping   # expect PONG
> ```
>
> The unmodified original is kept at `/opt/homebrew/etc/redis.conf.bak`. None
> of those four modules are used by BullMQ or by this application.

### 2. Create database roles

Two roles, deliberately:

- `billing_owner` — owns the schema, runs migrations.
- `billing_app` — the runtime role. **Not** a superuser and **without**
  `BYPASSRLS`, so row-level security actually applies to application queries.

```bash
psql -h localhost -d postgres <<'SQL'
CREATE ROLE billing_owner LOGIN PASSWORD 'billing_owner' CREATEDB;
CREATE ROLE billing_app   LOGIN PASSWORD 'billing_app';
SQL

createdb -h localhost -O billing_owner billing_dev

psql -h localhost -U billing_owner -d billing_dev <<'SQL'
GRANT USAGE ON SCHEMA public TO billing_app;
ALTER DEFAULT PRIVILEGES FOR ROLE billing_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO billing_app;
ALTER DEFAULT PRIVILEGES FOR ROLE billing_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO billing_app;
SQL
```

`CREATEDB` on `billing_owner` is required by Prisma Migrate for its shadow
database.

### 3. Configure environment

```bash
cp .env.example .env
```

Generate the two secrets and paste them in:

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY
```

`.env` is git-ignored. Only `.env.example` is committed, and only with empty
secret values. In production these come from a secret manager, never a file.

### 4. Install, migrate, seed

```bash
pnpm install
pnpm db:generate
pnpm db:migrate:deploy
pnpm db:seed
```

### 5. Run

```bash
pnpm dev            # everything via Turborepo
```

or individually:

```bash
pnpm --filter @billing/api dev       # http://localhost:4000
pnpm --filter @billing/web dev       # http://localhost:3000
pnpm --filter @billing/worker dev
```

### 6. Verify

```bash
curl http://localhost:4000/api/v1/health          # {"data":{"status":"ok"},...}
curl http://localhost:4000/api/v1/health/ready    # includes database check
```

Open <http://localhost:3000> and sign in with a seeded account.

## Seeded accounts

All use password `DevPassword123!`.

| Email               | Organisation       | Role    |
| ------------------- | ------------------ | ------- |
| `owner@acme.test`   | Acme Consulting    | OWNER   |
| `billing@acme.test` | Acme Consulting    | BILLING |
| `viewer@acme.test`  | Acme Consulting    | VIEWER  |
| `owner@globex.test` | Globex Corporation | OWNER   |

Two organisations exist on purpose: a cross-tenant leak should be visible in
ordinary development, not only under a special test fixture.

## Testing

```bash
pnpm test                                        # unit + integration
pnpm --filter @billing/database test             # numbering, incl. concurrency
pnpm --filter @billing/validation test           # money arithmetic
pnpm --filter @billing/types test                # permission matrix

bash tests/integration/tenant-isolation.sh       # needs API running
```

The tenant-isolation suite drives the real HTTP API against a real database.
It requires the API on `:4000` and covers: cross-tenant list leakage, direct
fetch by a known foreign UUID, forged organisation identifiers in header/query/
body, organisation switching without membership, and unauthenticated access.

## Layout

```
apps/
  api/        NestJS REST API, /api/v1
  web/        Next.js App Router frontend
  worker/     BullMQ background jobs
packages/
  database/   Prisma schema, migrations, seed, tenant-scoped client
  types/      Shared domain types, roles, permission matrix
  validation/ Zod schemas + decimal money helpers
  config/     Validated environment loading
tests/
  integration/
docs/
  architecture/adr/
```

## Security model

Five checks, in order, on every request (Security & Access Document §13):

1. Authenticated — `AuthGuard` resolves the session from an HttpOnly cookie.
2. Organisation membership — `OrganisationGuard` reads `organisation_members`.
3. Role permits the action — `@RequirePermission` against the matrix.
4. Record belongs to that organisation — enforced in the query **and** by RLS.
5. Business rules — status transitions, amount validation.

Tenant context comes only from the session row, which no client can write. A
mismatching `organisationId` in a header, query string, or body is rejected
with 403 rather than silently ignored.

Cross-tenant reads return **404, not 403**. A 403 would confirm the record
exists and turn the endpoint into an oracle for probing other tenants' UUIDs.

Postgres RLS is enabled on all tenant tables as defence-in-depth. It fails
closed: with no tenant context set, queries return zero rows.

## Money

Every monetary column is `NUMERIC(19,4)`. All arithmetic goes through
`decimal.js` via `packages/validation/src/money.ts`. Money crosses API
boundaries as a **string**, never a JSON number — a JSON number is an IEEE-754
double and would reintroduce exactly the rounding error the column type exists
to prevent.

Rounding policy: `ROUND_HALF_UP` at 4 decimal places, applied once per computed
field, defined in one place so it cannot drift between modules.

## Document numbering

Invoice and quotation numbers come from `document_sequences` via a single
atomic statement inside the creating transaction:

```sql
UPDATE document_sequences
   SET current_number = current_number + 1
 WHERE organisation_id = $1 AND document_type = $2
RETURNING current_number, prefix, padding;
```

Never `MAX(number)+1`. Postgres takes a row-level lock for the `UPDATE`, so
concurrent transactions serialise on that row and each reads a committed value.
Numbers are gapless: if the surrounding transaction rolls back, the increment
rolls back with it.

## Useful commands

| Command                  | Effect                                     |
| ------------------------ | ------------------------------------------ |
| `pnpm dev`               | Run all apps                               |
| `pnpm build`             | Build all apps                             |
| `pnpm typecheck`         | Typecheck the workspace                    |
| `pnpm db:migrate`        | Create + apply a migration (dev)           |
| `pnpm db:migrate:deploy` | Apply pending migrations (CI/prod)         |
| `pnpm db:seed`           | Seed development data (idempotent)         |
| `pnpm db:reset`          | **Drop and recreate** the database         |
| `pnpm db:studio`         | Prisma Studio                              |

## Known issues

### Web production build — `<Html>` prerender error (resolve pre-deploy)

`pnpm --filter @billing/web build` fails during static export with
`<Html> should not be imported outside of pages/_document`, thrown while
prerendering Next's built-in `/404`. `next dev` runs correctly and every route
renders and behaves as expected, so this blocks deployment only.

Not caused by application code: it reproduces with an empty `app/` containing
just a root layout and one trivial page, and persists across Next 15.1.3 and
15.5.23 with React pinned to 19.0.0.

**Already investigated and ruled out** (do not re-tread):

| Hypothesis | Result |
| --- | --- |
| Duplicate hoisted `next` | **Was real, now fixed.** `better-auth` declares `next` as an optional peer, so `apps/api` pulled a second copy (15.5.23) beside the web app's. Resolved via `overrides.next` + `peerDependencyRules.ignoreMissing` in `pnpm-workspace.yaml`. Tree now has exactly one `next` and one `react`/`react-dom`. **Error persists.** |
| Stray `pages/_document.*` / `pages/_app.*` | None anywhere in the workspace. |
| `app/global-error.tsx` | Contributory — with it present the build fails at `/404`, without it at `/500`. It has been **removed**; `app/not-found.tsx` remains. Error persists regardless. |
| Adding `pages/404.tsx`, `500.tsx`, `_error.tsx`, `_document.tsx` | Makes it worse: the guard then rejects `Html` from our own legitimate `_document`, indicating `next/document` resolves to a different instance than the export worker. Reverted. |
| Next 15.1.3 vs 15.5.23 | Fails identically on both, with a fully clean lockfile and deduped tree. |
| React 19.0.0 vs 19.2.8 | Fails on both; pinned to 19.0.0. |

Current state: single `next@15.5.23`, single `react@19.0.0`, no `pages/`
directory, no `global-error.tsx`, lockfile regenerated from scratch — and the
`/404` prerender still fails.

Remaining avenues for whoever picks this up: try `output: 'standalone'`, or
disable the export step, or reproduce in a bare Next app outside the workspace
to determine whether it is a Turborepo/pnpm interaction or a Next bug worth
filing upstream.
