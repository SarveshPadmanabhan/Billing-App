import { Prisma, type TenantClient } from '@billing/database';
import { conflict } from '../common/errors/app-error.js';

/**
 * Stock deduction and restoration for invoices.
 *
 * Concurrency (ADR-009: serialise first, then act; re-check inside the lock):
 * two invoices sent at the same moment for the last unit of an item must not
 * both succeed. Reading the quantity and then writing the movement is a
 * check-then-act race, so every affected item row is locked with
 * SELECT ... FOR UPDATE *before* its quantity is read, and the availability
 * check happens inside that lock.
 *
 * Items are locked in a deterministic order (by id). Two invoices sharing two
 * items in opposite orders would otherwise be a textbook deadlock.
 *
 * The partial unique index on (invoice_id, stock_item_id) WHERE
 * movement_type = 'OUT' is the database backstop: a retried send cannot
 * double-deduct even if the application logic is wrong. It is a backstop, not
 * the mechanism.
 */

interface StockLine {
  stockItemId: string;
  description: string;
  quantity: Prisma.Decimal;
}

/** Sum of an item's movements. Must be called while holding its row lock. */
async function ledgerQuantity(tx: TenantClient, stockItemId: string): Promise<Prisma.Decimal> {
  const rows = await tx.$queryRaw<Array<{ quantity: Prisma.Decimal }>>`
    SELECT COALESCE(SUM(
             CASE movement_type
               WHEN 'IN'         THEN quantity
               WHEN 'ADJUSTMENT' THEN quantity
               ELSE -quantity
             END), 0) AS quantity
      FROM stock_movements
     WHERE stock_item_id = ${stockItemId}::uuid
  `;
  return rows[0]?.quantity ?? new Prisma.Decimal(0);
}

async function recompute(tx: TenantClient, stockItemId: string): Promise<void> {
  const quantity = await ledgerQuantity(tx, stockItemId);
  await tx.stockItem.update({ where: { id: stockItemId }, data: { quantityOnHand: quantity } });
}

/**
 * Deduct stock for every tracked line on an invoice.
 *
 * Called inside the send transaction, so a shortfall rolls the whole send back
 * — the invoice is not issued if the goods cannot be committed.
 */
export async function deductForInvoice(
  tx: TenantClient,
  organisationId: string,
  companyId: string,
  invoiceId: string,
  userId: string | null,
): Promise<void> {
  const lines = await tx.invoiceItem.findMany({
    where: { invoiceId, stockItemId: { not: null } },
    select: { stockItemId: true, description: true, quantity: true },
  });
  if (lines.length === 0) return;

  // One invoice may list the same item on several lines; deduct the total once
  // so the per-invoice unique index holds and the arithmetic stays right.
  const totals = new Map<string, StockLine>();
  for (const line of lines) {
    const id = line.stockItemId!;
    const existing = totals.get(id);
    if (existing) existing.quantity = existing.quantity.plus(line.quantity);
    else
      totals.set(id, {
        stockItemId: id,
        description: line.description,
        quantity: line.quantity,
      });
  }

  // Deterministic lock order prevents deadlock between two concurrent sends
  // that share items in different line orders.
  const ordered = [...totals.values()].sort((a, b) => a.stockItemId.localeCompare(b.stockItemId));

  for (const line of ordered) {
    const locked = await tx.$queryRaw<Array<{ id: string; name: string; tracks_stock: boolean }>>`
      SELECT id, name, tracks_stock FROM stock_items
       WHERE id = ${line.stockItemId}::uuid
         AND organisation_id = ${organisationId}::uuid
       FOR UPDATE
    `;

    const item = locked[0];
    // A line pointing at a deleted or another tenant's item is a data error,
    // not a stock shortage; skipping silently would issue goods off the books.
    if (!item) {
      throw conflict(
        'STOCK_ITEM_NOT_FOUND',
        `Invoice line "${line.description}" refers to a stock item that no longer exists`,
      );
    }

    if (!item.tracks_stock) continue;

    // Re-read inside the lock. A quantity read before the lock could already
    // be stale by the time the movement is written.
    const available = await ledgerQuantity(tx, line.stockItemId);
    if (available.lt(line.quantity)) {
      throw conflict(
        'INSUFFICIENT_STOCK',
        `${item.name}: ${available.toFixed(4)} in stock, invoice needs ${line.quantity.toFixed(4)}`,
      );
    }

    await tx.stockMovement.create({
      data: {
        organisationId,
        companyId,
        stockItemId: line.stockItemId,
        movementType: 'OUT',
        quantity: line.quantity,
        invoiceId,
        reason: 'Invoice issued',
        createdBy: userId,
      },
    });

    await recompute(tx, line.stockItemId);
  }
}

/**
 * Return stock that an invoice took, when that invoice is cancelled.
 *
 * Recorded as new IN movements rather than by deleting the OUT rows: the
 * movement table is append-only, and the history of goods leaving and coming
 * back is exactly what an auditor needs to see.
 *
 * Idempotent. A second cancel finds the reversal already present and does
 * nothing, so a retry cannot inflate stock.
 */
export async function restoreForInvoice(
  tx: TenantClient,
  organisationId: string,
  companyId: string,
  invoiceId: string,
  userId: string | null,
): Promise<void> {
  const taken = await tx.stockMovement.findMany({
    where: { invoiceId, movementType: 'OUT' },
    select: { stockItemId: true, quantity: true },
  });
  if (taken.length === 0) return;

  const alreadyReturned = await tx.stockMovement.findMany({
    where: { invoiceId, movementType: 'IN' },
    select: { stockItemId: true },
  });
  const returned = new Set(alreadyReturned.map((m) => m.stockItemId));

  const ordered = [...taken].sort((a, b) => a.stockItemId.localeCompare(b.stockItemId));

  for (const movement of ordered) {
    if (returned.has(movement.stockItemId)) continue;

    await tx.$queryRaw`
      SELECT id FROM stock_items
       WHERE id = ${movement.stockItemId}::uuid
         AND organisation_id = ${organisationId}::uuid
       FOR UPDATE
    `;

    await tx.stockMovement.create({
      data: {
        organisationId,
        companyId,
        stockItemId: movement.stockItemId,
        movementType: 'IN',
        quantity: movement.quantity,
        invoiceId,
        reason: 'Invoice cancelled',
        createdBy: userId,
      },
    });

    await recompute(tx, movement.stockItemId);
  }
}
