import { z } from 'zod';
import { emailSchema, paginationSchema, uuidSchema } from './schemas.js';

/**
 * Customer schemas (TICKET-010, TICKET-011, TICKET-012).
 *
 * Note what is absent: `organisationId`, `isArchived`, and any computed
 * balance. Those are server-controlled. Because these schemas strip unknown
 * keys, a client that posts them has them discarded rather than honoured.
 */

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v === '' ? null : v));

const addressFields = {
  addressLine1: optionalTrimmed(255),
  addressLine2: optionalTrimmed(255),
  city: optionalTrimmed(100),
  state: optionalTrimmed(100),
  postalCode: optionalTrimmed(30),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .length(2)
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
};

export const CUSTOMER_TYPES = ['INDIVIDUAL', 'COMPANY'] as const;

export const createCustomerSchema = z
  .object({
    customerType: z.enum(CUSTOMER_TYPES).default('COMPANY'),
    companyName: optionalTrimmed(255),
    contactName: optionalTrimmed(255),
    // Email is optional: Security Doc §27 requires supporting customers with
    // no email (walk-in trade), but it must be valid when present.
    email: emailSchema.optional().nullable().or(z.literal('').transform(() => null)),
    phone: optionalTrimmed(30),
    taxNumber: optionalTrimmed(100),

    billing: z.object(addressFields).partial().optional(),
    shipping: z.object(addressFields).partial().optional(),
    /** Copy billing into shipping server-side rather than trusting the client. */
    shippingSameAsBilling: z.boolean().default(false),

    notes: optionalTrimmed(5000),
  })
  .superRefine((data, ctx) => {
    // A customer must be identifiable by something. Which field is required
    // depends on the type: companies need a company name, individuals a
    // contact name.
    if (data.customerType === 'COMPANY' && !data.companyName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['companyName'],
        message: 'Company name is required for a company customer',
      });
    }
    if (data.customerType === 'INDIVIDUAL' && !data.contactName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contactName'],
        message: 'Contact name is required for an individual customer',
      });
    }
  });

/**
 * Update schema.
 *
 * `.partial()` cannot be applied to the effect-wrapped create schema, so the
 * shape is restated. customerType is intentionally NOT updatable: switching an
 * existing customer between COMPANY and INDIVIDUAL would invalidate the
 * required-name rule for documents already issued to them.
 */
export const updateCustomerSchema = z.object({
  companyName: optionalTrimmed(255),
  contactName: optionalTrimmed(255),
  email: emailSchema.optional().nullable().or(z.literal('').transform(() => null)),
  phone: optionalTrimmed(30),
  taxNumber: optionalTrimmed(100),
  billing: z.object(addressFields).partial().optional(),
  shipping: z.object(addressFields).partial().optional(),
  shippingSameAsBilling: z.boolean().optional(),
  notes: optionalTrimmed(5000),
  /**
   * Optimistic concurrency (Security Doc §24). When supplied, the update is
   * rejected if the record changed since the client loaded it.
   */
  expectedUpdatedAt: z.string().datetime().optional(),
});

export const customerListQuerySchema = paginationSchema.extend({
  /** Matches company name, contact name, email, or phone. */
  search: z.string().trim().max(200).optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
  sort: z.enum(['createdAt', 'companyName', 'outstanding']).default('createdAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

export const archiveCustomerSchema = z.object({
  /** Explicit intent, so an accidental PATCH cannot archive a customer. */
  confirm: z.literal(true, {
    errorMap: () => ({ message: 'Archiving must be explicitly confirmed' }),
  }),
  reason: optionalTrimmed(500),
});

export const customerIdParamSchema = z.object({ id: uuidSchema });

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;
export type ArchiveCustomerInput = z.infer<typeof archiveCustomerSchema>;
