import { z } from 'zod';

/**
 * Stock schemas.
 *
 * Quantities are decimal strings across the API boundary, never JSON numbers —
 * the same rule money follows. A stock quantity multiplies into a money figure
 * on an invoice, so float drift here becomes money drift there.
 */

const decimalString = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,4})?$/, `${label} must be a number with up to 4 decimal places`);

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v === '' ? null : v));

export const createStockItemSchema = z.object({
  sku: z.string().trim().min(1, 'SKU is required').max(64),
  name: z.string().trim().min(1, 'Name is required').max(255),
  description: optionalTrimmed(2000),
  unit: z.string().trim().min(1).max(20).default('unit'),
  unitPrice: decimalString('Unit price').default('0'),
  /** Opening balance. Recorded as an IN movement, not written to the column. */
  openingQuantity: decimalString('Opening quantity').default('0'),
  /** Defaults to 25; the form no longer collects it. See schema.prisma. */
  reorderLevel: decimalString('Reorder level').default('25'),
  tracksStock: z.boolean().default(true),
});

export const updateStockItemSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: optionalTrimmed(2000),
  unit: z.string().trim().min(1).max(20).optional(),
  unitPrice: decimalString('Unit price').optional(),
  reorderLevel: decimalString('Reorder level').optional(),
  tracksStock: z.boolean().optional(),
  /**
   * quantityOnHand is absent on purpose. It is derived from the movement
   * ledger, so setting it directly would put the column and its history out of
   * step. Use the adjust endpoint, which writes a movement.
   */
});

export const adjustStockSchema = z.object({
  /** IN adds, OUT removes, ADJUSTMENT sets an absolute counted figure. */
  movementType: z.enum(['IN', 'OUT', 'ADJUSTMENT']),
  quantity: decimalString('Quantity'),
  reason: z.string().trim().max(255).optional().nullable(),
});

export const stockListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  /** Only items at or below their reorder level. */
  lowStock: z.enum(['true', 'false']).optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
});

export type CreateStockItemInput = z.infer<typeof createStockItemSchema>;
export type UpdateStockItemInput = z.infer<typeof updateStockItemSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
export type StockListQuery = z.infer<typeof stockListQuerySchema>;
