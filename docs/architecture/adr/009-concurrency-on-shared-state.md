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

## Testing rule

**A concurrency guarantee is not established until a test has run it
concurrently.** Sequential tests pass against all three broken designs above.

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

## Consequences

- Contended operations serialise briefly. At MVP volumes this is microseconds,
  and correctness outranks throughput for financial state.
- Under a PDF race, both requests still render; only one row is written. The
  wasted render is acceptable — a request-level debounce is a future option if
  it ever shows up as a real cost.
- Anything added later that touches shared document or sequence state
  (credit notes, receipt numbering, recurring invoices) must follow this
  pattern and ship its own concurrent test.
