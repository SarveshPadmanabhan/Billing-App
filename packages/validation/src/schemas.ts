import { z } from 'zod';
import { ORGANISATION_ROLES } from '@billing/types';
import { toDecimal } from './money.js';

/**
 * Shared request schemas. Used by the API for enforcement and by the web app
 * for client-side hinting. The API's copy is authoritative.
 */

/** Money accepted from clients: a decimal string, max 4 dp, never a float. */
export const moneyString = (field = 'amount') =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => /^-?\d{1,15}(\.\d{1,4})?$/.test(v), {
      message: `${field} must be a number with at most 4 decimal places`,
    })
    .refine(
      (v) => {
        try {
          toDecimal(v, field);
          return true;
        } catch {
          return false;
        }
      },
      { message: `${field} is outside the supported range` },
    );

export const nonNegativeMoney = (field = 'amount') =>
  moneyString(field).refine((v) => !v.startsWith('-'), {
    message: `${field} must not be negative`,
  });

export const positiveMoney = (field = 'amount') =>
  moneyString(field).refine((v) => toDecimal(v, field).greaterThan(0), {
    message: `${field} must be greater than zero`,
  });

/** 0–100 inclusive. Blocks the "101% discount" abuse in Security Doc §34. */
export const percentageRate = (field = 'rate') =>
  moneyString(field).refine(
    (v) => {
      const d = toDecimal(v, field);
      return d.greaterThanOrEqualTo(0) && d.lessThanOrEqualTo(100);
    },
    { message: `${field} must be between 0 and 100` },
  );

export const uuidSchema = z.string().uuid('Must be a valid identifier');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Email is required')
  .max(255, 'Email must be 255 characters or fewer')
  .email('Enter a valid email address');

/** Security Doc §4: minimum 10–12 characters. We take the stricter bound. */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(256, 'Password must be 256 characters or fewer');

export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(3, 'Currency must be a 3-letter code')
  .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter code');

export const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(2, 'Country must be a 2-letter code')
  .regex(/^[A-Z]{2}$/, 'Country must be a 2-letter code');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Capped to blunt the "excessive pagination" probe in Security Doc §33.
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  firstName: z.string().trim().min(1, 'First name is required').max(100),
  lastName: z.string().trim().max(100).optional().nullable(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});

export const createOrganisationSchema = z.object({
  name: z.string().trim().min(1, 'Organisation name is required').max(255),
  legalName: z.string().trim().max(255).optional().nullable(),
  email: emailSchema.optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  website: z.string().trim().url('Enter a valid URL').max(2048).optional().nullable().or(z.literal('')),
  addressLine1: z.string().trim().max(255).optional().nullable(),
  addressLine2: z.string().trim().max(255).optional().nullable(),
  city: z.string().trim().max(100).optional().nullable(),
  state: z.string().trim().max(100).optional().nullable(),
  postalCode: z.string().trim().max(30).optional().nullable(),
  countryCode: countryCodeSchema.default('IN'),
  taxNumber: z.string().trim().max(100).optional().nullable(),
  currencyCode: currencyCodeSchema.default('INR'),
  timezone: z.string().trim().max(100).default('Asia/Kolkata'),

  // Numbering + document defaults (TICKET-005 / TICKET-006).
  invoicePrefix: z.string().trim().min(1).max(10).default('INV-'),
  quotationPrefix: z.string().trim().min(1).max(10).default('QUO-'),
  invoiceStartNumber: z.coerce.number().int().min(1).max(999999999).default(1),
  quotationStartNumber: z.coerce.number().int().min(1).max(999999999).default(1),
  defaultPaymentTermsDays: z.coerce.number().int().min(0).max(365).default(30),
  defaultTaxRate: percentageRate('Default tax rate').default('0'),
  defaultNotes: z.string().trim().max(5000).optional().nullable(),
  defaultTerms: z.string().trim().max(5000).optional().nullable(),
  dateFormat: z.enum(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD']).default('DD/MM/YYYY'),
});

export const updateOrganisationSchema = createOrganisationSchema.partial();

export const inviteUserSchema = z.object({
  email: emailSchema,
  role: z.enum(ORGANISATION_ROLES),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateOrganisationInput = z.infer<typeof createOrganisationSchema>;
export type UpdateOrganisationInput = z.infer<typeof updateOrganisationSchema>;
