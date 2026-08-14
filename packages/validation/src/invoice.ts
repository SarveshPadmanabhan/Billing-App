import { z } from 'zod';
import { uuidSchema, paginationSchema } from './schemas.js';
import { quotationItemSchema } from './quotation.js';

/**
 * Invoice schemas (TICKET-024, TICKET-027, TICKET-028, TICKET-030).
 *
 * Line items share the quotation shape — the two documents carry identical
 * line structure, and one schema keeps a converted quotation and its invoice
 * from drifting apart.
 *
 * Clients may not send invoiceNumber, any total, amountPaid, amountDue, or
 * status. Numbers come from the sequence, money is recomputed from line items,
 * and balances are maintained by the payment transaction.
 */

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Enter a valid date');

const decimalInput = (field: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => /^\d{1,15}(\.\d{1,4})?$/.test(v), {
      message: `${field} must be a positive number with at most 4 decimal places`,
    });

const percentInput = (field: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => /^\d{1,3}(\.\d{1,4})?$/.test(v) && Number(v) <= 100, {
      message: `${field} must be between 0 and 100`,
    });

export const invoiceItemSchema = quotationItemSchema;

const documentDiscountSchema = z
  .object({
    rate: percentInput('Discount rate').optional().nullable(),
    amount: decimalInput('Discount').optional().nullable(),
  })
  .refine((d) => !(d.rate != null && d.amount != null), {
    message: 'Provide either a discount rate or a discount amount, not both',
    path: ['rate'],
  });

export const createInvoiceSchema = z
  .object({
    customerId: uuidSchema,
    issueDate: dateOnly,
    /** Optional: defaults to issueDate + the organisation's payment terms. */
    dueDate: dateOnly.optional().nullable(),
    items: z.array(invoiceItemSchema).min(1, 'Add at least one line item').max(500),
    discount: documentDiscountSchema.optional().nullable(),
    notes: z.string().trim().max(5000).optional().nullable(),
    terms: z.string().trim().max(5000).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.dueDate && data.dueDate < data.issueDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dueDate'],
        message: 'Due date must be on or after the invoice date',
      });
    }
  });

export const updateInvoiceSchema = z
  .object({
    customerId: uuidSchema.optional(),
    issueDate: dateOnly.optional(),
    dueDate: dateOnly.optional().nullable(),
    items: z.array(invoiceItemSchema).min(1).max(500).optional(),
    discount: documentDiscountSchema.optional().nullable(),
    notes: z.string().trim().max(5000).optional().nullable(),
    terms: z.string().trim().max(5000).optional().nullable(),
    expectedVersion: z.coerce.number().int().positive().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.dueDate && data.issueDate && data.dueDate < data.issueDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dueDate'],
        message: 'Due date must be on or after the invoice date',
      });
    }
  });

export const INVOICE_STATUS_FILTERS = [
  'DRAFT',
  'SENT',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'CANCELLED',
] as const;

export const invoiceListQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(200).optional(),
  status: z.enum(INVOICE_STATUS_FILTERS).optional(),
  customerId: uuidSchema.optional(),
  dateFrom: dateOnly.optional(),
  dateTo: dateOnly.optional(),
  /** Convenience filter: everything still owing money. */
  outstanding: z.enum(['true', 'false']).optional(),
  sort: z.enum(['issueDate', 'dueDate', 'invoiceNumber', 'totalAmount', 'amountDue']).default('issueDate'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * Cancellation requires a reason.
 *
 * An issued invoice is never deleted (Security Doc §41 rule 6); cancelling is
 * the only withdrawal path, and the reason becomes part of the audit trail.
 */
export const cancelInvoiceSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required to cancel an invoice').max(1000),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;
export type CancelInvoiceInput = z.infer<typeof cancelInvoiceSchema>;
