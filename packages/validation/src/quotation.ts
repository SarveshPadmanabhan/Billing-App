import { z } from 'zod';
import { uuidSchema, paginationSchema } from './schemas.js';

/**
 * Quotation schemas (TICKET-016, TICKET-018, TICKET-019, TICKET-021).
 *
 * Note what clients may NOT send: quotationNumber, subtotal, taxAmount,
 * totalAmount, status, or any line total. Numbers come from the sequence and
 * every monetary figure is recomputed server-side from quantity, unitPrice,
 * discount and tax (Security Doc §16, §41 rule 2). Unknown keys are stripped,
 * so a client that sends them has them discarded rather than honoured.
 */

/** A calendar date, not a timestamp — quotations are dated, not timed. */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Enter a valid date');

/** Numeric input for quantities and prices: decimal string, max 4 dp. */
const decimalInput = (field: string, { allowZero = false } = {}) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => /^\d{1,15}(\.\d{1,4})?$/.test(v), {
      message: `${field} must be a positive number with at most 4 decimal places`,
    })
    .refine((v) => allowZero || Number(v) > 0, { message: `${field} must be greater than zero` });

const percentInput = (field: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => /^\d{1,3}(\.\d{1,4})?$/.test(v) && Number(v) <= 100, {
      message: `${field} must be between 0 and 100`,
    });

export const quotationItemSchema = z
  .object({
    description: z.string().trim().min(1, 'Description is required').max(2000),
    quantity: decimalInput('Quantity'),
    unit: z.string().trim().max(30).optional().nullable(),
    unitPrice: decimalInput('Unit price', { allowZero: true }),
    discountRate: percentInput('Discount rate').optional().nullable(),
    discountAmount: decimalInput('Discount', { allowZero: true }).optional().nullable(),
    taxRate: percentInput('Tax rate').optional().nullable(),
  })
  .refine((item) => !(item.discountRate != null && item.discountAmount != null), {
    message: 'Provide either a discount rate or a discount amount, not both',
    path: ['discountRate'],
  });

const documentDiscountSchema = z
  .object({
    rate: percentInput('Discount rate').optional().nullable(),
    amount: decimalInput('Discount', { allowZero: true }).optional().nullable(),
  })
  .refine((d) => !(d.rate != null && d.amount != null), {
    message: 'Provide either a discount rate or a discount amount, not both',
    path: ['rate'],
  });

export const createQuotationSchema = z
  .object({
    customerId: uuidSchema,
    issueDate: dateOnly,
    validUntil: dateOnly.optional().nullable(),
    items: z.array(quotationItemSchema).min(1, 'Add at least one line item').max(500),
    discount: documentDiscountSchema.optional().nullable(),
    notes: z.string().trim().max(5000).optional().nullable(),
    terms: z.string().trim().max(5000).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.validUntil && data.validUntil < data.issueDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validUntil'],
        message: 'Valid-until date must be on or after the issue date',
      });
    }
  });

/**
 * Draft edit (TICKET-018).
 *
 * Items are replaced wholesale rather than patched: a partial item update
 * would require reconciling positions and could leave totals inconsistent with
 * the stored lines. `expectedVersion` provides optimistic concurrency.
 */
export const updateQuotationSchema = z
  .object({
    customerId: uuidSchema.optional(),
    issueDate: dateOnly.optional(),
    validUntil: dateOnly.optional().nullable(),
    items: z.array(quotationItemSchema).min(1).max(500).optional(),
    discount: documentDiscountSchema.optional().nullable(),
    notes: z.string().trim().max(5000).optional().nullable(),
    terms: z.string().trim().max(5000).optional().nullable(),
    expectedVersion: z.coerce.number().int().positive().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.validUntil && data.issueDate && data.validUntil < data.issueDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validUntil'],
        message: 'Valid-until date must be on or after the issue date',
      });
    }
  });

export const QUOTATION_STATUS_FILTERS = [
  'DRAFT',
  'SENT',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'CONVERTED',
  'CANCELLED',
] as const;

export const quotationListQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(200).optional(),
  status: z.enum(QUOTATION_STATUS_FILTERS).optional(),
  customerId: uuidSchema.optional(),
  dateFrom: dateOnly.optional(),
  dateTo: dateOnly.optional(),
  sort: z.enum(['issueDate', 'quotationNumber', 'totalAmount']).default('issueDate'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

/** Lifecycle actions (TICKET-019). Each is a POST, never a status PATCH. */
export const rejectQuotationSchema = z.object({
  reason: z.string().trim().max(1000).optional().nullable(),
});

export const cancelQuotationSchema = z.object({
  reason: z.string().trim().max(1000).optional().nullable(),
});

/** Conversion (TICKET-022). Dates are optional; org defaults fill the gaps. */
export const convertQuotationSchema = z.object({
  issueDate: dateOnly.optional(),
  dueDate: dateOnly.optional(),
  notes: z.string().trim().max(5000).optional().nullable(),
  terms: z.string().trim().max(5000).optional().nullable(),
});

export type CreateQuotationInput = z.infer<typeof createQuotationSchema>;
export type UpdateQuotationInput = z.infer<typeof updateQuotationSchema>;
export type QuotationListQuery = z.infer<typeof quotationListQuerySchema>;
export type ConvertQuotationInput = z.infer<typeof convertQuotationSchema>;
export type QuotationItemInput = z.infer<typeof quotationItemSchema>;
