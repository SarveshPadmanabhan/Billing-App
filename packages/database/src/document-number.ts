import { Prisma } from '@prisma/client';
import type { TenantClient } from './client.js';

/**
 * Race-safe document numbering (TICKET-006).
 *
 * Why not MAX(number)+1 (explicitly banned by Tech Arch Doc §11 and Security
 * Doc §20): two concurrent transactions both read the same MAX under READ
 * COMMITTED and both write N+1. The unique index turns that into a failed
 * request at best, a duplicate at worst.
 *
 * The mechanism here is a single atomic statement:
 *
 *     UPDATE document_sequences
 *        SET current_number = current_number + 1
 *      WHERE organisation_id = $1 AND document_type = $2
 *  RETURNING current_number, prefix, padding;
 *
 * Postgres takes a row-level exclusive lock for the UPDATE. A concurrent
 * transaction touching the same row blocks until the first commits, then
 * re-reads the *committed* value and increments from there. Serialisation is
 * per (organisation, document_type), so tenants never block each other.
 *
 * This must be called inside the same transaction that inserts the document.
 * If that insert rolls back, the increment rolls back with it — numbers stay
 * gapless. (Gapless is a deliberate choice: many tax regimes require unbroken
 * invoice sequences. The cost is that concurrent creations serialise briefly
 * on this row; at MVP scale that is microseconds.)
 */

export type SequenceDocumentType = 'INVOICE' | 'QUOTATION';

export interface GeneratedDocumentNumber {
  /** Formatted, e.g. "INV-000042". */
  formatted: string;
  /** Raw counter value, e.g. 42n. */
  sequence: bigint;
}

export class DocumentSequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentSequenceError';
  }
}

interface SequenceRow {
  current_number: bigint;
  prefix: string;
  padding: number;
}

/**
 * Atomically reserve the next number for (organisationId, documentType).
 *
 * @param tx  A transaction client — REQUIRED. Passing a non-transactional
 *            client would release the lock immediately and reintroduce the race.
 */
export async function nextDocumentNumber(
  tx: TenantClient,
  organisationId: string,
  documentType: SequenceDocumentType,
): Promise<GeneratedDocumentNumber> {
  const rows = await tx.$queryRaw<SequenceRow[]>`
    UPDATE document_sequences
       SET current_number = current_number + 1,
           updated_at     = now()
     WHERE organisation_id = ${organisationId}::uuid
       AND document_type   = ${documentType}::document_number_type
    RETURNING current_number, prefix, padding
  `;

  const row = rows[0];
  if (!row) {
    // The sequence is created with the organisation (TICKET-005), so a miss
    // means either a bad org id or a provisioning bug. Never auto-create here:
    // doing so under concurrency would race on the insert instead.
    throw new DocumentSequenceError(
      `No ${documentType} sequence for organisation ${organisationId}`,
    );
  }

  return {
    formatted: formatDocumentNumber(row.prefix, row.current_number, row.padding),
    sequence: row.current_number,
  };
}

export function formatDocumentNumber(prefix: string, value: bigint, padding: number): string {
  return `${prefix}${value.toString().padStart(padding, '0')}`;
}

/**
 * Create the INVOICE and QUOTATION sequences for a new organisation.
 *
 * current_number is seeded to (startNumber - 1) because nextDocumentNumber
 * pre-increments: a startNumber of 1 stores 0 and the first document is 1.
 */
export async function createDocumentSequences(
  tx: TenantClient,
  organisationId: string,
  options: {
    invoicePrefix: string;
    quotationPrefix: string;
    invoiceStartNumber: bigint;
    quotationStartNumber: bigint;
    padding: number;
  },
): Promise<void> {
  if (options.invoiceStartNumber < 1n || options.quotationStartNumber < 1n) {
    throw new DocumentSequenceError('Start numbers must be at least 1');
  }

  await tx.documentSequence.createMany({
    data: [
      {
        organisationId,
        documentType: 'INVOICE',
        prefix: options.invoicePrefix,
        padding: options.padding,
        currentNumber: options.invoiceStartNumber - 1n,
      },
      {
        organisationId,
        documentType: 'QUOTATION',
        prefix: options.quotationPrefix,
        padding: options.padding,
        currentNumber: options.quotationStartNumber - 1n,
      },
    ],
    skipDuplicates: true,
  });
}

/** True when an error is a unique-constraint violation on a document number. */
export function isDuplicateDocumentNumber(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    String(error.meta?.target ?? '').includes('number')
  );
}
