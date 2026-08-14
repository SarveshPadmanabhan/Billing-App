# ADR-006: Document number generation

## Status
Accepted — Phase 1 (TICKET-006).

## Context
Duplicate invoice numbers are a financial and legal defect. Both source
documents explicitly forbid `SELECT MAX(number)+1` (Tech Arch §11, Security §20):
under READ COMMITTED, two concurrent transactions read the same maximum and
both write N+1.

## Decision
A `document_sequences` row per `(organisation_id, document_type)`, incremented
by a single atomic statement inside the transaction that creates the document:

```sql
UPDATE document_sequences
   SET current_number = current_number + 1
 WHERE organisation_id = $1 AND document_type = $2
RETURNING current_number, prefix, padding;
```

Postgres takes a row-level exclusive lock for the `UPDATE`. A concurrent
transaction on the same row blocks until the first commits, then re-reads the
committed value. Serialisation is per organisation and document type, so
tenants never block each other.

`nextDocumentNumber` requires a transaction client. Passing a non-transactional
client would release the lock immediately and reintroduce the race.

## Verification
`packages/database/src/document-number.test.ts` runs against a real database:

- 64 concurrent `withTenant` transactions → 64 unique, gapless numbers (1–64).
- 25 concurrent per organisation × 2 organisations → each counts 1–25 in its
  own namespace.
- 32 concurrent transactions that reserve a number *and* insert the invoice,
  exercising the `(organisation_id, invoice_number)` unique index.
- Rollback test: an aborted transaction does not consume a number.

A separate instrumented probe confirmed a peak of **61 simultaneously in-flight
transactions**, verifying the test exercises real contention rather than being
serialised by a connection pool of one.

## Consequences
- Numbers are **gapless**, which many tax regimes require. The cost is brief
  serialisation per organisation on concurrent creation — microseconds at MVP
  scale.
- A sequence must exist before the first document; it is created with the
  organisation (TICKET-005). `nextDocumentNumber` never auto-creates one, since
  doing so under concurrency would just move the race to the insert.
- Postgres native `SEQUENCE` objects were rejected: they are not transactional
  (gaps on rollback) and would need one sequence per organisation.
