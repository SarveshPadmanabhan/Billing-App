import { Injectable } from '@nestjs/common';
import { Prisma, withTenant, type TenantClient } from '@billing/database';
import type { OrganisationContext } from '@billing/types';
import type {
  CreateStockItemInput,
  UpdateStockItemInput,
  AdjustStockInput,
  StockListQuery,
} from '@billing/validation';
import { notFound, conflict } from '../common/errors/app-error.js';

/**
 * Stock items and their movement ledger.
 *
 * The invariant everything here protects: quantity_on_hand always equals the
 * sum of the item's movements. It is stored for query speed but never
 * incremented in place — every change recomputes it from stock_movements.
 * This is ADR-009's ledger principle, the same rule invoice balances follow.
 */
@Injectable()
export class StockService {
  /**
   * Recompute an item's quantity from its movements.
   *
   * Deliberately a full re-sum rather than applying a delta. A delta is
   * correct only if every previous delta was correct; re-summing is correct
   * unconditionally, and a bug elsewhere cannot accumulate silently.
   *
   * Callers must already hold the item's row lock — see adjust() and
   * deductForInvoice().
   */
  private async recomputeQuantity(tx: TenantClient, stockItemId: string): Promise<Prisma.Decimal> {
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

    const quantity = rows[0]?.quantity ?? new Prisma.Decimal(0);
    await tx.stockItem.update({ where: { id: stockItemId }, data: { quantityOnHand: quantity } });
    return quantity;
  }

  async list(org: OrganisationContext, query: StockListQuery) {
    return withTenant(org.organisationId, async (tx) => {
      const where: Prisma.StockItemWhereInput = {
        organisationId: org.organisationId,
        companyId: org.companyId,
      };

      if (query.status === 'active') where.isArchived = false;
      else if (query.status === 'archived') where.isArchived = true;

      if (query.search) {
        const contains = { contains: query.search, mode: 'insensitive' as const };
        where.OR = [{ name: contains }, { sku: contains }];
      }

      const [items, total] = await Promise.all([
        tx.stockItem.findMany({
          where,
          orderBy: [{ name: 'asc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        tx.stockItem.count({ where }),
      ]);

      // Low stock is a comparison between two columns, which Prisma cannot
      // express in a where clause, so it is filtered after the query. At MVP
      // page sizes that is fine; it would need raw SQL to paginate correctly
      // at scale, which is noted rather than pretended away.
      const visible =
        query.lowStock === 'true'
          ? items.filter((i) => i.tracksStock && i.quantityOnHand.lte(i.reorderLevel))
          : items;

      return {
        items: visible.map(serialise),
        total,
        page: query.page,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      };
    });
  }

  async get(org: OrganisationContext, id: string) {
    return withTenant(org.organisationId, async (tx) => {
      const item = await tx.stockItem.findFirst({
        where: { id, organisationId: org.organisationId },
        include: {
          movements: {
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: {
              id: true,
              movementType: true,
              quantity: true,
              reason: true,
              invoiceId: true,
              createdAt: true,
            },
          },
        },
      });

      // 404 rather than 403 for another tenant's item: a 403 confirms the id
      // exists and turns this into an enumeration oracle (Security Doc §16).
      if (!item) throw notFound('STOCK_ITEM_NOT_FOUND', `Stock item ${id} not found`);

      return {
        ...serialise(item),
        movements: item.movements.map((m) => ({
          ...m,
          quantity: m.quantity.toFixed(4),
          createdAt: m.createdAt.toISOString(),
        })),
      };
    });
  }

  async create(org: OrganisationContext, input: CreateStockItemInput, userId: string) {
    return withTenant(org.organisationId, async (tx) => {
      const duplicate = await tx.stockItem.findFirst({
        where: { companyId: org.companyId, sku: input.sku },
        select: { id: true },
      });
      if (duplicate) {
        throw conflict('STOCK_SKU_TAKEN', `SKU "${input.sku}" already exists in this company`);
      }

      const item = await tx.stockItem.create({
        data: {
          organisationId: org.organisationId,
          companyId: org.companyId,
          sku: input.sku,
          name: input.name,
          description: input.description ?? null,
          unit: input.unit,
          unitPrice: new Prisma.Decimal(input.unitPrice),
          reorderLevel: new Prisma.Decimal(input.reorderLevel),
          tracksStock: input.tracksStock,
          // Left at 0 and derived below, so the column is never a figure
          // nobody can trace back to a movement.
          quantityOnHand: new Prisma.Decimal(0),
        },
      });

      const opening = new Prisma.Decimal(input.openingQuantity);
      if (opening.gt(0)) {
        await tx.stockMovement.create({
          data: {
            organisationId: org.organisationId,
            companyId: org.companyId,
            stockItemId: item.id,
            movementType: 'IN',
            quantity: opening,
            reason: 'Opening balance',
            createdBy: userId,
          },
        });
        await this.recomputeQuantity(tx, item.id);
      }

      const fresh = await tx.stockItem.findUniqueOrThrow({ where: { id: item.id } });
      return serialise(fresh);
    });
  }

  async update(org: OrganisationContext, id: string, input: UpdateStockItemInput) {
    return withTenant(org.organisationId, async (tx) => {
      const before = await tx.stockItem.findFirst({
        where: { id, organisationId: org.organisationId },
        select: { id: true },
      });
      if (!before) throw notFound('STOCK_ITEM_NOT_FOUND', `Stock item ${id} not found`);

      const item = await tx.stockItem.update({
        where: { id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.unit !== undefined && { unit: input.unit }),
          ...(input.unitPrice !== undefined && { unitPrice: new Prisma.Decimal(input.unitPrice) }),
          ...(input.reorderLevel !== undefined && {
            reorderLevel: new Prisma.Decimal(input.reorderLevel),
          }),
          ...(input.tracksStock !== undefined && { tracksStock: input.tracksStock }),
        },
      });
      return serialise(item);
    });
  }

  /**
   * Record a manual movement.
   *
   * Serialise first, then act (ADR-009): the item row is locked before the
   * movement is written, so two concurrent adjustments cannot both read the
   * same starting quantity and produce a total that reflects only one of them.
   */
  async adjust(org: OrganisationContext, id: string, input: AdjustStockInput, userId: string) {
    return withTenant(org.organisationId, async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; tracks_stock: boolean }>>`
        SELECT id, tracks_stock FROM stock_items
         WHERE id = ${id}::uuid AND organisation_id = ${org.organisationId}::uuid
         FOR UPDATE
      `;
      if (locked.length === 0) {
        throw notFound('STOCK_ITEM_NOT_FOUND', `Stock item ${id} not found`);
      }

      const quantity = new Prisma.Decimal(input.quantity);

      if (input.movementType === 'ADJUSTMENT') {
        // An absolute count. Stored as the difference from the current total
        // so the ledger still sums to the counted figure.
        const current = await this.currentQuantity(tx, id);
        const delta = quantity.minus(current);
        if (!delta.isZero()) {
          await tx.stockMovement.create({
            data: {
              organisationId: org.organisationId,
              companyId: org.companyId,
              stockItemId: id,
              // The check constraint requires a positive quantity, so a
              // downward correction is recorded as an OUT of the difference
              // rather than a negative ADJUSTMENT.
              ...(delta.gt(0)
                ? { movementType: 'ADJUSTMENT' as const, quantity: delta }
                : { movementType: 'OUT' as const, quantity: delta.abs() }),
              reason: input.reason ?? 'Stock count',
              createdBy: userId,
            },
          });
        }
      } else {
        if (input.movementType === 'OUT') {
          const current = await this.currentQuantity(tx, id);
          if (current.lt(quantity)) {
            throw conflict(
              'INSUFFICIENT_STOCK',
              `Only ${current.toFixed(4)} in stock, cannot remove ${quantity.toFixed(4)}`,
            );
          }
        }
        await tx.stockMovement.create({
          data: {
            organisationId: org.organisationId,
            companyId: org.companyId,
            stockItemId: id,
            movementType: input.movementType,
            quantity,
            reason: input.reason ?? null,
            createdBy: userId,
          },
        });
      }

      await this.recomputeQuantity(tx, id);
      const fresh = await tx.stockItem.findUniqueOrThrow({ where: { id } });
      return serialise(fresh);
    });
  }

  /** Sum of movements. Read inside a lock by callers that then write. */
  private async currentQuantity(tx: TenantClient, stockItemId: string): Promise<Prisma.Decimal> {
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
}

function serialise(item: {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  unit: string;
  unitPrice: Prisma.Decimal;
  quantityOnHand: Prisma.Decimal;
  reorderLevel: Prisma.Decimal;
  tracksStock: boolean;
  isArchived: boolean;
}) {
  // Decimals cross the API as strings, never JSON numbers (Frontend Spec §37).
  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    description: item.description,
    unit: item.unit,
    unitPrice: item.unitPrice.toFixed(4),
    quantityOnHand: item.quantityOnHand.toFixed(4),
    reorderLevel: item.reorderLevel.toFixed(4),
    tracksStock: item.tracksStock,
    isArchived: item.isArchived,
    isLow: item.tracksStock && item.quantityOnHand.lte(item.reorderLevel),
  };
}
