import { describe, it, expect } from 'vitest';
import { createCustomerSchema, updateCustomerSchema } from './customer.js';

/**
 * Billing address is required (create and update).
 *
 * An invoice records the billing address as evidence of who was charged and
 * in which tax jurisdiction, so it cannot be completed after the fact.
 * Shipping stays optional, and `addressLine2` is never required.
 */

const completeBilling = {
  addressLine1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
  countryCode: 'IN',
};

const base = { customerType: 'COMPANY' as const, companyName: 'Acme Pvt Ltd' };

const pathsOf = (result: { success: boolean; error?: { issues: { path: (string | number)[] }[] } }) =>
  result.success ? [] : (result.error?.issues ?? []).map((i) => i.path.join('.'));

describe('createCustomerSchema billing address', () => {
  it('accepts a complete billing address', () => {
    const r = createCustomerSchema.safeParse({ ...base, billing: completeBilling });
    expect(r.success).toBe(true);
  });

  it.each(['addressLine1', 'city', 'state', 'postalCode', 'countryCode'] as const)(
    'rejects a missing %s',
    (field) => {
      const billing = { ...completeBilling, [field]: undefined };
      const r = createCustomerSchema.safeParse({ ...base, billing });
      expect(r.success).toBe(false);
      expect(pathsOf(r)).toContain(`billing.${field}`);
    },
  );

  it('rejects an omitted billing address entirely, naming every field', () => {
    const r = createCustomerSchema.safeParse(base);
    expect(r.success).toBe(false);
    const paths = pathsOf(r);
    for (const f of ['addressLine1', 'city', 'state', 'postalCode', 'countryCode']) {
      expect(paths).toContain(`billing.${f}`);
    }
  });

  it('treats whitespace-only values as missing', () => {
    const r = createCustomerSchema.safeParse({
      ...base,
      billing: { ...completeBilling, city: '   ' },
    });
    expect(r.success).toBe(false);
    expect(pathsOf(r)).toContain('billing.city');
  });

  it('does not require addressLine2', () => {
    const r = createCustomerSchema.safeParse({ ...base, billing: completeBilling });
    expect(r.success).toBe(true);
    expect(pathsOf(r)).not.toContain('billing.addressLine2');
  });

  it('does not require a shipping address', () => {
    const r = createCustomerSchema.safeParse({ ...base, billing: completeBilling });
    expect(r.success).toBe(true);
  });

  it('does not apply the rule to shipping when one is partially given', () => {
    const r = createCustomerSchema.safeParse({
      ...base,
      billing: completeBilling,
      shipping: { city: 'Mumbai' },
    });
    expect(r.success).toBe(true);
  });
});

describe('updateCustomerSchema billing address', () => {
  it('allows an update that does not touch the address', () => {
    // The 183 existing customers with incomplete addresses must remain
    // editable in other respects; only a submitted address must be complete.
    const r = updateCustomerSchema.safeParse({ phone: '+91 98765 43210' });
    expect(r.success).toBe(true);
  });

  it('requires completeness once a billing address is supplied', () => {
    const r = updateCustomerSchema.safeParse({ billing: { city: 'Bengaluru' } });
    expect(r.success).toBe(false);
    expect(pathsOf(r)).toContain('billing.addressLine1');
  });

  it('accepts a complete billing address', () => {
    const r = updateCustomerSchema.safeParse({ billing: completeBilling });
    expect(r.success).toBe(true);
  });

  it('rejects blanking out a field on an existing address', () => {
    const r = updateCustomerSchema.safeParse({
      billing: { ...completeBilling, postalCode: '' },
    });
    expect(r.success).toBe(false);
    expect(pathsOf(r)).toContain('billing.postalCode');
  });
});
