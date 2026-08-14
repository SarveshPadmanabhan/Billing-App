import { z } from 'zod';
import { uuidSchema, paginationSchema } from './schemas.js';

/**
 * Payment schemas (TICKET-031 … TICKET-034).
 *
 * Payments are the first operation that mutates money on an already-issued
 * document, so the input rules are deliberately tight:
 *   - amount must be strictly positive (Security Doc §30 rejects zero and
 *     negative payments);
 *   - the payment date cannot be in the future — you cannot receive money you
 *     have not received;
 *   - an idempotency key is required, so a retry or double-click resolves to
 *     the payment already recorded rather than taking the money twice.
 */

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Enter a valid date');

/** Positive money with at most 4 decimal places. */
const positiveAmount = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d{1,15}(\.\d{1,4})?$/.test(v), {
    message: 'Amount must be a number with at most 4 decimal places',
  })
  .refine((v) => Number(v) > 0, { message: 'Amount must be greater than zero' });

export const PAYMENT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'CARD',
  'CHEQUE',
  'UPI',
  'OTHER',
] as const;

export const recordPaymentSchema = z
  .object({
    amount: positiveAmount,
    paymentDate: dateOnly,
    paymentMethod: z.enum(PAYMENT_METHODS),
    reference: z.string().trim().max(255).optional().nullable(),
    notes: z.string().trim().max(2000).optional().nullable(),
    /**
     * Client-generated, stable across retries of the same logical payment.
     * Required rather than optional: making it optional would leave the
     * duplicate-payment window open for any caller that forgot it.
     */
    idempotencyKey: z
      .string()
      .trim()
      .min(8, 'Idempotency key must be at least 8 characters')
      .max(255),
  })
  .superRefine((data, ctx) => {
    // Future-dated payments are rejected: money cannot be received tomorrow.
    // Compared as date-only in UTC so the rule does not shift with timezone.
    const today = new Date();
    const todayIso = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    )
      .toISOString()
      .slice(0, 10);

    if (data.paymentDate > todayIso) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paymentDate'],
        message: 'Payment date cannot be in the future',
      });
    }
  });

export const voidPaymentSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required to void a payment').max(1000),
});

export const paymentListQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(200).optional(),
  customerId: uuidSchema.optional(),
  invoiceId: uuidSchema.optional(),
  status: z.enum(['RECORDED', 'VOIDED']).optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  dateFrom: dateOnly.optional(),
  dateTo: dateOnly.optional(),
  sort: z.enum(['paymentDate', 'amount', 'paymentNumber']).default('paymentDate'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export type VoidPaymentInput = z.infer<typeof voidPaymentSchema>;
export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;
