# Billing Platform

Multi-tenant SaaS for organisation billing: customers, quotations, invoices,
payments, PDFs and reporting.

This is a financial application. Data integrity, tenant isolation and
auditability take precedence over delivery speed.

**Status:** Phase 1 (Foundation) and Phase 2 (core billing workflow) complete —
TICKET-001 through TICKET-041. The full loop works end to end:
customer → quotation → invoice → payment, with PDFs, search, filters and a
dashboard.

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

### 2b. Object storage (MinIO) and PDF rendering

Needed for quotation/invoice PDFs (TICKET-020, TICKET-029).

```bash
brew install minio minio-mc
```

> The `minio` formula is marked deprecated (archived upstream repo, disabled
> from 2027-02-17). It is fine for local development; production uses real
> S3-compatible storage, so nothing depends on the formula surviving.

Start the server with explicit dev credentials — not the defaults:

```bash
mkdir -p ~/.minio-billing-data
MINIO_ROOT_USER=billing_minio MINIO_ROOT_PASSWORD=billing_minio_dev_secret \
  minio server --address :9000 --console-address :9001 ~/.minio-billing-data
```

Create the bucket (private by default — do not make it public):

```bash
mc alias set billing-local http://localhost:9000 billing_minio billing_minio_dev_secret
mc mb --ignore-existing billing-local/billing-documents
mc anonymous get billing-local/billing-documents   # must print: private
```

Console at <http://localhost:9001>. Verify isolation holds:

```bash
# Anonymous access must be refused.
curl -o /dev/null -w '%{http_code}\n' http://localhost:9000/billing-documents/anything   # 403
```

Install the headless browser used for PDF rendering:

```bash
pnpm --filter @billing/worker exec playwright install chromium
```

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

> `pnpm db:reset:demo` restores the two seeded organisations to a clean state
> if manual exploration has cluttered them. It only touches those two
> organisations and refuses to run in production.

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

### Troubleshooting

**`__webpack_modules__[moduleId] is not a function`** on any page, with a stack
entirely inside Next and React internals and no frames in application code.
This is a stale `.next` cache, not a code bug. `next build` and `next dev`
share the same `.next` directory, so running a production build and then the
dev server (or the reverse) leaves a manifest from one build under the webpack
runtime of the other, and the module IDs no longer line up. Fix:

```bash
pnpm --filter @billing/web dev:clean    # rm -rf .next && pnpm dev
```

**Signed in, but landed on the onboarding screen** even though the account
already belongs to an organisation. A session has no active organisation until
one is selected — `session.activeOrganisationId` is server-written only, and
sign-in does not set it, even for a user with exactly one membership. Pick the
organisation from the switcher in the app shell.

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

Three layers, each catching what the others cannot.

```bash
pnpm test              # unit — pure logic, no I/O
pnpm test:integration  # HTTP API against a real database (needs API on :4000)
pnpm test:e2e          # real browser (needs API and web running)
pnpm test:all          # all three
```

**Unit** (`packages/*/src/*.test.ts`) — money arithmetic, the calculation
engine, the permission matrix, and document numbering under 64-way
concurrency.

**Integration** (`tests/integration/*.sh`) — each drives the real HTTP API
against a real database, with two organisations, and asserts tenant isolation
as well as behaviour:

| Suite | Covers |
| --- | --- |
| `tenant-isolation.sh` | Cross-tenant leakage, foreign UUIDs, forged organisation ids, unauthenticated access |
| `customers.sh` | CRUD, search, archive-not-delete, optimistic concurrency |
| `quotations.sh` | Lifecycle, server-side totals, duplicate, conversion incl. 8-way concurrent conversion |
| `invoices.sh` | Lifecycle, cancel-not-delete, overdue detection, BILLING scoped cancel |
| `payments.sh` | Idempotency, overpayment rejection, voiding, and three concurrency races |
| `search.sh` | Global search across all three types, combined filters, tenant scoping |
| `dashboard.sh` | KPIs cross-checked against the module endpoints they summarise |
| `pdf.sh` | Content-hash caching, concurrent generation, signed-URL access control |
| `integrity.sh` | Audits database state directly — balances against the ledger, totals against line items, numbering, cross-tenant references |

**E2E** (`tests/e2e/*.spec.ts`) — a small Playwright suite over the critical
path. It exists because API-level tests once passed while the app was
completely broken in a browser: a CORS preflight misconfiguration blocked
every sign-in, and curl does not send preflights. Keep it fast and keep it
running.

`integrity.sh` is different from the others: it exercises no endpoints, it
audits the resulting state. It catches drift regardless of cause — a bug, a
partial failure, or a careless manual repair — and runs last, after the other
suites have generated data. It connects as a superuser because an audit must
see every tenant, and it self-checks that it can read rows before trusting any
result: a query that silently fails would otherwise report zero violations.

Concurrency guarantees are covered by tests that actually run concurrently —
see [ADR-009](docs/architecture/adr/009-concurrency-on-shared-state.md), which
also records the "derive balances from the ledger, never increment them"
principle that any future work on stored money aggregates must follow, and
three testing rules built on one instinct: a passing result is a claim, not
evidence. A check must be proven capable of failing, and a green build or test
must be verified by its output rather than its exit code — `nest build` once
exited 0 while emitting nothing at all.

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

## Writing migrations

Two things bite in this schema specifically.

**Tenant-scoped tables need per-organisation context, even for the owner.**
Every table under RLS uses `FORCE ROW LEVEL SECURITY`, so `billing_owner` is
subject to the policies too. A bulk statement across organisations therefore
inserts **zero rows, silently and without error**:

```sql
-- WRONG: no tenant context, WITH CHECK rejects every row, exit code 0
INSERT INTO document_sequences (organisation_id, document_type, ...)
SELECT o.id, 'PAYMENT', ... FROM organisations o;
```

Loop and set the context instead:

```sql
DO $$
DECLARE org RECORD;
BEGIN
  FOR org IN SELECT id FROM organisations LOOP
    PERFORM set_config('app.current_organisation_id', org.id::text, true);
    INSERT INTO document_sequences (...) VALUES (org.id, ...)
      ON CONFLICT DO NOTHING;
  END LOOP;
END;
$$;
```

`20260814140000_payment_number_sequence` is the worked example. Always verify a
back-fill by counting rows afterwards *with* tenant context set — an unscoped
`SELECT count(*)` reports 0 whether the insert worked or not.

**`ALTER TYPE ... ADD VALUE` cannot run inside a transaction** on PostgreSQL
below 12, and Prisma wraps migrations in one. Adding an enum value may need to
be applied separately and the migration then recorded as applied.

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

### Web production build — resolved

`pnpm build` works. This section is kept because the failure was misleading and
the lesson generalises.

**Symptom:** the build failed during static export with
`<Html> should not be imported outside of pages/_document`, thrown while
prerendering Next's built-in `/404`. `next dev` worked perfectly.

**What it was not:** duplicate `next` copies (there was one, since fixed),
stray `pages/_document`, `global-error.tsx`, or the Next/React versions. Hours
went into each of those.

**What it actually was:** `NODE_ENV=development` leaking into the production
build. The build script ran `dotenv -e ../../.env -- next build`, and the
shared `.env` sets `NODE_ENV=development` for the API and worker. Next then
took a code path that routed `/404` through the Pages Router runtime, whose
`<Html>` import tripped its own guard — an error with no visible connection to
the cause. Next did warn ("You are using a non-standard NODE_ENV value"), and
that warning was the whole answer, dismissed as noise for weeks.

Underneath it sat a second, real bug the misleading error had masked: `/login`
called `useSearchParams()` without a Suspense boundary, which bails the page
out of prerendering. Fixed by wrapping the form.

**Two lessons worth keeping:**

- A shared `.env` must not be piped into a production build. `apps/web/.env.production`
  now holds only `NEXT_PUBLIC_*` values, and `pnpm build` is plain `next build`
  so Next sets `NODE_ENV` itself.
- When a framework warns about something you did not ask about, read it before
  dismissing it. The warning appeared in every failing build from the start.


