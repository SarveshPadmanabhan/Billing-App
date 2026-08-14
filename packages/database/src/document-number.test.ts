import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nextDocumentNumber, formatDocumentNumber, DocumentSequenceError } from './document-number.js';
import { withTenant } from './client.js';

/**
 * TICKET-006 — document numbering under concurrency.
 *
 * Runs against the real database. The whole point is to exercise Postgres's
 * row-locking behaviour, which no mock can reproduce.
 */

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

// A dedicated pool: 64 concurrent transactions each need their own connection,
// and the default limit would serialise them at the pool instead of in the DB —
// which would make the test pass for the wrong reason.
const url = new URL(process.env.DATABASE_URL ?? '');
url.searchParams.set('connection_limit', '80');
url.searchParams.set('pool_timeout', '30');

const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });

async function resetSequence(organisationId: string, documentType: 'INVOICE' | 'QUOTATION') {
  // Inside withTenant: document_sequences is RLS-protected, so an unscoped
  // UPDATE would silently affect zero rows and leave the test misconfigured.
  await withTenant(
    organisationId,
    (tx) => tx.$executeRaw`
      UPDATE document_sequences SET current_number = 0
       WHERE organisation_id = ${organisationId}::uuid
         AND document_type = ${documentType}::document_number_type
    `,
    prisma,
  );
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await resetSequence(ORG_A, 'INVOICE');
  await resetSequence(ORG_A, 'QUOTATION');
  await resetSequence(ORG_B, 'INVOICE');
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetSequence(ORG_A, 'INVOICE');
  await resetSequence(ORG_A, 'QUOTATION');
  await resetSequence(ORG_B, 'INVOICE');
});

describe('formatDocumentNumber', () => {
  it('pads to the configured width', () => {
    expect(formatDocumentNumber('INV-', 1n, 6)).toBe('INV-000001');
    expect(formatDocumentNumber('INV-', 42n, 6)).toBe('INV-000042');
    expect(formatDocumentNumber('QUO-', 999999n, 6)).toBe('QUO-999999');
  });

  it('does not truncate once the counter exceeds the padding', () => {
    expect(formatDocumentNumber('INV-', 1000000n, 6)).toBe('INV-1000000');
  });
});

describe('nextDocumentNumber — sequential', () => {
  it('starts at 1 and increments', async () => {
    const first = await withTenant(ORG_A, (tx) => nextDocumentNumber(tx, ORG_A, 'INVOICE'), prisma);
    const second = await withTenant(ORG_A, (tx) => nextDocumentNumber(tx, ORG_A, 'INVOICE'), prisma);

    expect(first.formatted).toBe('INV-000001');
    expect(second.formatted).toBe('INV-000002');
  });

  it('keeps INVOICE and QUOTATION counters independent', async () => {
    const invoice = await withTenant(ORG_A, (tx) => nextDocumentNumber(tx, ORG_A, 'INVOICE'), prisma);
    const quotation = await withTenant(ORG_A, (tx) => nextDocumentNumber(tx, ORG_A, 'QUOTATION'), prisma);

    expect(invoice.formatted).toBe('INV-000001');
    expect(quotation.formatted).toBe('QUO-000001');
  });

  it('keeps organisations independent', async () => {
    const a = await withTenant(ORG_A, (tx) => nextDocumentNumber(tx, ORG_A, 'INVOICE'), prisma);
    const b = await withTenant(ORG_B, (tx) => nextDocumentNumber(tx, ORG_B, 'INVOICE'), prisma);

    expect(a.formatted).toBe('INV-000001');
    expect(b.formatted).toBe('GBX-000001'); // Org B's own prefix.
  });

  it('rejects an organisation with no sequence row', async () => {
    const orphan = '33333333-3333-3333-3333-333333333333';
    await expect(
      withTenant(orphan, (tx) => nextDocumentNumber(tx, orphan, 'INVOICE'), prisma),
    ).rejects.toThrow(DocumentSequenceError);
  });

  it('rolls the number back when the surrounding transaction aborts', async () => {
    await expect(
      withTenant(
        ORG_A,
        async (tx) => {
          await nextDocumentNumber(tx, ORG_A, 'INVOICE');
          throw new Error('simulated failure after reserving a number');
        },
        prisma,
      ),
    ).rejects.toThrow('simulated failure');

    // Gapless: the aborted reservation must not consume 000001.
    const next = await withTenant(ORG_A, (tx) => nextDocumentNumber(tx, ORG_A, 'INVOICE'), prisma);
    expect(next.formatted).toBe('INV-000001');
  });
});

describe('nextDocumentNumber — concurrent (the TICKET-006 acceptance test)', () => {
  it('produces no duplicates across 64 simultaneous requests', async () => {
    const CONCURRENCY = 64;

    // Fire all transactions at once. Promise.all starts them together, so they
    // genuinely contend for the same sequence row.
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        withTenant(ORG_A, (tx) => nextDocumentNumber(tx, ORG_A, 'INVOICE'), prisma),
      ),
    );

    const numbers = results.map((r) => r.formatted);
    const unique = new Set(numbers);

    expect(unique.size).toBe(CONCURRENCY);

    // Gapless 1..64 — not merely distinct.
    const sequences = results.map((r) => Number(r.sequence)).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: CONCURRENCY }, (_, i) => i + 1));
  }, 60_000);

  it('does not let concurrent tenants interfere with each other', async () => {
    const PER_ORG = 25;

    const [aResults, bResults] = await Promise.all([
      Promise.all(
        Array.from({ length: PER_ORG }, () =>
          withTenant(ORG_A, (tx) => nextDocumentNumber(tx, ORG_A, 'INVOICE'), prisma),
        ),
      ),
      Promise.all(
        Array.from({ length: PER_ORG }, () =>
          withTenant(ORG_B, (tx) => nextDocumentNumber(tx, ORG_B, 'INVOICE'), prisma),
        ),
      ),
    ]);

    expect(new Set(aResults.map((r) => r.formatted)).size).toBe(PER_ORG);
    expect(new Set(bResults.map((r) => r.formatted)).size).toBe(PER_ORG);

    // Each org counts 1..25 in its own namespace.
    expect(aResults.map((r) => Number(r.sequence)).sort((a, b) => a - b)).toEqual(
      Array.from({ length: PER_ORG }, (_, i) => i + 1),
    );
    expect(bResults.map((r) => Number(r.sequence)).sort((a, b) => a - b)).toEqual(
      Array.from({ length: PER_ORG }, (_, i) => i + 1),
    );
  }, 60_000);

  it('survives the unique index under concurrent inserts of real invoices', async () => {
    // End-to-end: reserve a number AND insert the invoice row in one
    // transaction, so the (organisation_id, invoice_number) unique index is
    // actually exercised. A duplicate would raise P2002 here.
    const CONCURRENCY = 32;

    // Must run inside tenant context — RLS hides these rows otherwise.
    const { customerId, createdBy } = await withTenant(
      ORG_A,
      async (tx) => {
        const customer = await tx.customer.findFirstOrThrow({
          where: { organisationId: ORG_A },
          select: { id: true },
        });
        const member = await tx.organisationMember.findFirstOrThrow({
          where: { organisationId: ORG_A },
          select: { userId: true },
        });
        return { customerId: customer.id, createdBy: member.userId };
      },
      prisma,
    );

    const created = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        withTenant(
          ORG_A,
          async (tx) => {
            const number = await nextDocumentNumber(tx, ORG_A, 'INVOICE');
            return tx.invoice.create({
              data: {
                organisationId: ORG_A,
                customerId,
                invoiceNumber: number.formatted,
                issueDate: new Date('2026-01-15'),
                dueDate: new Date('2026-02-14'),
                currencyCode: 'INR',
                createdBy,
                subtotal: '0',
                totalAmount: '0',
                amountDue: '0',
              },
              select: { invoiceNumber: true },
            });
          },
          prisma,
        ),
      ),
    );

    const numbers = created.map((i) => i.invoiceNumber);
    expect(new Set(numbers).size).toBe(CONCURRENCY);

    // Clean up so repeat runs stay deterministic.
    await withTenant(
      ORG_A,
      (tx) => tx.invoice.deleteMany({ where: { invoiceNumber: { in: numbers } } }),
      prisma,
    );
  }, 60_000);
});
