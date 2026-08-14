# ADR-009: Concurrency on shared document and sequence state

## Status
Accepted — Phase 2.

## Context

Three separate features in this codebase mutate state shared across concurrent
requests:

1. **Document numbering** (TICKET-006) — `document_sequences.current_number`
2. **Quotation conversion** (TICKET-022) — one quotation must yield one invoice
3. **PDF generation** (TICKET-020/029) — one document row per rendered version

Two of the three were first implemented with designs that read correctly in
review and passed every sequential test, then failed the moment they were run
concurrently:

| Attempted design | Why it failed |
| --- | --- |
| `SELECT MAX(n)+1` then insert | Both transactions read the same max under READ COMMITTED and computed the same next value. Explicitly forbidden by Tech Arch §11 / Security §20. |
| Read `MAX(version)`, then insert, relying on a unique index to catch races | Every concurrent request read the same max *before* any had inserted, so each computed a **different** version. The rows genuinely differed, the index never fired, and 10 requests produced 8 duplicate rows. |
| Catch the unique-violation (P2002) and re-query for the winner | A constraint violation aborts the Postgres transaction. The recovery query fails with `25P02: current transaction is aborted`. Returns 500s instead of resolving. |

## Decision

**Serialise first, then act. Re-check inside the lock.**

Any operation mutating shared document or sequence state must:

1. Take a lock scoped to the contended resource, before reading the value it
   intends to base a write on.
2. Re-read that value inside the lock — the state may have changed while
   waiting, and the whole point is to observe the change.
3. Act on the re-read value.
4. Keep a unique constraint as a backstop, but never as the primary mechanism.

Which lock depends on what is being contended:

- **An existing row** → `SELECT … FOR UPDATE`
  (`nextDocumentNumber` uses `UPDATE … RETURNING`, which locks implicitly;
  `convertToInvoice` locks the quotation explicitly.)
- **A row that does not exist yet** → `pg_advisory_xact_lock(key)`
  You cannot row-lock a row you are about to create. PDF generation locks on
  a hash of `(organisationId, entityId)`.

Advisory locks here are transaction-scoped (`_xact_`), so they release on
commit *or* rollback with no cleanup path to forget. They are keyed per
resource, so unrelated documents never block each other, and cost nothing when
uncontended.

## Testing rules: a check you haven't watched fail isn't a check

Three rules, each learned the harder way than the last. They share one
instinct: **a passing result is a claim, not evidence.** Establish that the
check ran, that it ran the real thing, and that it was capable of saying no.

**1. A concurrency guarantee is not established until a test has run it
concurrently.** Sequential tests pass against all three broken designs above.

**2. Any test or audit guarding a rare condition must be proven capable of
failing, not merely observed passing.** A green result has two possible
causes — the invariant holds, or the check is broken — and they are
indistinguishable from the output alone.

**3. A green build or test result has proven nothing until you have confirmed
it actually built or ran what it claims to.** Rules 1 and 2 assume the check
executed at all. This one does not. Exit code 0 means "the tool did not
report an error" — it does not mean the tool did any work. Verify the
artefact, not the exit code: did files get emitted, did tests get collected,
did the loop have rows to iterate over?

This is not hypothetical. All three have happened in this codebase:

- The E2E smoke suite was validated by reintroducing the CORS-preflight bug:
  5 of 6 tests failed while every API test stayed green. Without that
  exercise, "8 passed" would have meant nothing.
- `integrity.sh` shipped its first version reporting **26/26 passing while
  checking nothing.** Listing organisations is itself under RLS, so the query
  returned zero rows, the per-tenant loop never executed, and every check
  summed to 0 — which is exactly what "no violations" looks like. A second bug
  compounded it: errors were suppressed with `2>/dev/null`, so a failed query
  returned an empty string that arithmetic treated as 0.
- `nest build` **exited 0 while emitting nothing.** `apps/api` had
  `incremental: true` in its tsconfig alongside nest's `deleteOutDir: true`:
  the `.tsbuildinfo` recorded every file as already emitted, `deleteOutDir`
  then removed them, and the next build skipped emitting because the buildinfo
  said there was nothing to do. A fresh clone worked (no buildinfo yet), so
  this only appeared on rebuild — the worst kind of intermittent. Fixed with
  `incremental: false`, proven by building twice consecutively and confirming
  `dist` was populated both times.
- `pnpm test` **failed permanently while testing nothing.** `apps/api` ran
  vitest against a directory with no test files, exiting 1 every time. The
  API's real coverage lives in `tests/integration/*.sh`. An always-red suite
  is as useless as an always-green one: both stop carrying information, and
  people learn to ignore the output.

Practical consequences for anything in this class:

- **Inject the failure and watch it fail** before trusting the check. Repair
  afterwards.
- **Never suppress errors** in an assertion path. A query that cannot run must
  report a failure, never a zero.
- **Make scope visible in the output.** `integrity.sh` prints
  "auditing 68 organisation(s)" so a collapse to zero tenants is obvious rather
  than silent.
- **Refuse to run rather than pass** when preconditions are unmet — the audit
  exits non-zero if it cannot read any rows.
- **Check the artefact, not the exit code.** A build is verified by inspecting
  its output directory; a test run by its collected-test count. "Found 0
  errors" and "0 tests ran" look identical in a summary line.
- **Treat an always-red result as broken too.** A suite that cannot pass gets
  ignored just as fast as one that cannot fail.

Every feature in this class ships with a test that fires N simultaneous
requests via `Promise.all` or backgrounded `curl` and asserts the invariant on
the resulting rows — not merely that no error was returned. Where a connection
pool could serialise the requests and produce a false pass, the test must
confirm genuine parallelism (the numbering test measured 61 transactions
in flight at peak).

Current coverage:

| Feature | Test | Invariant |
| --- | --- | --- |
| Numbering | `packages/database/src/document-number.test.ts` | 64 concurrent → 64 unique, gapless |
| Conversion | `tests/integration/quotations.sh` | 8 concurrent → exactly 1 invoice |
| PDF | `tests/integration/pdf.sh` | 10 concurrent → exactly 1 document row |
| Payment recording | `tests/integration/payments.sh` §5 | 10 concurrent × 200 vs 1000 balance → exactly 5 succeed, never negative |
| Double void | `tests/integration/payments.sh` §7 | 4 concurrent voids → exactly 1 succeeds, reversed once |
| Void vs. payment | `tests/integration/payments.sh` §8 | Balance matches surviving RECORDED allocations under either interleaving |

## Companion principle: derive balances from the ledger, never increment them

Locking makes concurrent writes *ordered*. It does not make a running total
*correct* — that needs a second rule.

**Any stored financial aggregate is recomputed from its underlying rows inside
the transaction that changes them. It is never adjusted by a delta.**

Concretely, recording or voiding a payment does not do:

```ts
amountPaid = amountPaid + payment.amount   // WRONG
```

It does:

```ts
amountPaid = sum(allocations where payment.status = 'RECORDED')   // RIGHT
```

Why this matters more than it first appears:

- **An increment is only correct if every prior write was.** One bad delta —
  from a bug since fixed, a partial failure, a manual repair — is baked in
  permanently and every later increment carries it forward. A recomputation
  is self-correcting: the next write repairs the stored value from the source
  rows.
- **It makes concurrent outcomes order-independent.** In the void-racing-a-
  payment test, both operations committed. Because each recomputed from the
  ledger rather than applying its own delta, the final `amountPaid` was
  correct regardless of which ran second. With increments, the answer would
  depend on interleaving.
- **The stored value stays auditable.** `amountPaid` is a cache of the
  allocation rows, so the two can be compared and any disagreement is a
  detectable bug rather than an invisible one. The payment tests assert this
  agreement explicitly.

Stored aggregates governed by this rule today: `invoices.amount_paid` and
`invoices.amount_due`, via `PaymentsService.applyBalance`, which is the single
definition of both. Anything added later that touches them — credit notes,
refunds, write-offs, multi-invoice allocation — must call through that same
path rather than adjusting the columns directly.

The columns are still stored rather than computed on read: the dashboard,
reports and invoice list must agree with each other and stay fast. Storing the
figure is a performance decision; deriving it on every write is the
correctness decision that makes storing it safe.

## Consequences

- Contended operations serialise briefly. At MVP volumes this is microseconds,
  and correctness outranks throughput for financial state.
- Under a PDF race, both requests still render; only one row is written. The
  wasted render is acceptable — a request-level debounce is a future option if
  it ever shows up as a real cost.
- Anything added later that touches shared document or sequence state
  (credit notes, receipt numbering, recurring invoices) must follow this
  pattern and ship its own concurrent test.
- Anything that changes a stored financial aggregate must recompute it from
  the source rows, per the companion principle above.
- Anything added to the build or test pipeline must be verified by its output
  rather than its exit status, per testing rule 3 — a step that silently does
  no work is indistinguishable from one that succeeds.
