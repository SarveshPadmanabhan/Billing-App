import { z } from 'zod';

/**
 * Company schemas — legal entities within an organisation.
 *
 * Note what is absent: `organisationId` and `isDefault`. Both are
 * server-controlled. The organisation comes from the verified session, and the
 * default company is set only by the dedicated endpoint, so a client cannot
 * create a company under another tenant or silently promote one to default.
 */

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v === '' ? null : v));

const prefix = (fallback: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(10)
    // A prefix ending in a digit would run into the padded number and make
    // "ACME1000001" ambiguous to read and impossible to parse back.
    .regex(/[^0-9]$/, 'Prefix must not end in a digit')
    .default(fallback);

export const createCompanySchema = z.object({
  name: z.string().trim().min(1, 'Company name is required').max(255),
  legalName: optionalTrimmed(255),
  email: z.string().trim().email().max(255).optional().nullable().or(z.literal('').transform(() => null)),
  phone: optionalTrimmed(30),
  addressLine1: optionalTrimmed(255),
  addressLine2: optionalTrimmed(255),
  city: optionalTrimmed(100),
  state: optionalTrimmed(100),
  postalCode: optionalTrimmed(30),
  countryCode: z.string().trim().toUpperCase().length(2).default('IN'),
  /**
   * UPI ID (VPA) this company collects into, e.g. "name@bank".
   *
   * Shape-checked only. The handle is not validated against a list of known
   * providers — banks add handles regularly, and rejecting a valid-but-
   * unrecognised one would block a legitimate payee.
   */
  upiId: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/, 'Enter a UPI ID like name@bank')
    .max(255)
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  taxNumber: optionalTrimmed(100),
  currencyCode: z.string().trim().toUpperCase().length(3).default('INR'),

  // Each company mints its own number series, so distinct prefixes are what
  // keep two companies' invoices tellable apart at a glance.
  invoicePrefix: prefix('INV-'),
  quotationPrefix: prefix('QUO-'),
  paymentPrefix: prefix('PAY-'),
});

export const updateCompanySchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  legalName: optionalTrimmed(255),
  email: z.string().trim().email().max(255).optional().nullable().or(z.literal('').transform(() => null)),
  phone: optionalTrimmed(30),
  addressLine1: optionalTrimmed(255),
  addressLine2: optionalTrimmed(255),
  city: optionalTrimmed(100),
  state: optionalTrimmed(100),
  postalCode: optionalTrimmed(30),
  countryCode: z.string().trim().toUpperCase().length(2).optional(),
  /**
   * UPI ID (VPA) this company collects into, e.g. "name@bank".
   *
   * Shape-checked only. The handle is not validated against a list of known
   * providers — banks add handles regularly, and rejecting a valid-but-
   * unrecognised one would block a legitimate payee.
   */
  upiId: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/, 'Enter a UPI ID like name@bank')
    .max(255)
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  taxNumber: optionalTrimmed(100),
  /**
   * currencyCode and the numbering prefixes are intentionally absent.
   * Documents already issued carry both; changing them retroactively would
   * make historical invoices inconsistent with the company that issued them.
   */
});

export const switchCompanySchema = z.object({
  companyId: z.string().uuid(),
});

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
export type SwitchCompanyInput = z.infer<typeof switchCompanySchema>;
