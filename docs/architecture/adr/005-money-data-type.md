# ADR-005: Money representation

## Status
Accepted — Phase 1.

## Context
JavaScript numbers are IEEE-754 doubles. `0.1 + 0.2 === 0.30000000000000004`
and `1.005 * 100 === 100.49999999999999`. In a billing total that is a defect,
not a rounding curiosity.

## Decision
- **Storage:** `NUMERIC(19,4)` on every monetary column. Verified by query
  after migration: zero money columns deviate.
- **Computation:** `decimal.js`, via `packages/validation/src/money.ts`. No
  arithmetic operator is applied to a money value anywhere else.
- **Transport:** money crosses every boundary as a **decimal string**. The API
  response interceptor serialises `Prisma.Decimal` to string, never to a JSON
  number, which would silently reintroduce float error at the edge.
- **Rounding:** `ROUND_HALF_UP` at 4 dp, applied once per computed field,
  defined in exactly one place. Security Doc §31 requires the policy be fixed
  before launch; this is that decision.
- **Range:** values outside `NUMERIC(19,4)` are rejected at parse time rather
  than truncated by the database.

## Consequences
- Frontend code must not do money arithmetic. It formats strings for display.
- `BigInt` (sequence counters) is likewise serialised to string; a JSON number
  loses precision beyond 2^53.
- 11 unit tests cover float-drift cases, half-up rounding at the 4th decimal,
  the small values called out in Security Doc §31, 1000-item accumulation, and
  range rejection.
