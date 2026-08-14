import { describe, it, expect } from 'vitest';
import {
  hasPermission,
  permissionsForRole,
  PERMISSIONS,
  ORGANISATION_ROLES,
  checkScopedPermission,
  auditActionPrefixFilter,
} from './roles.js';

describe('permission matrix', () => {
  it('grants OWNER everything', () => {
    for (const permission of PERMISSIONS) {
      expect(hasPermission('OWNER', permission)).toBe(true);
    }
  });

  it('withholds ownership transfer from everyone but OWNER', () => {
    for (const role of ORGANISATION_ROLES) {
      expect(hasPermission(role, 'organisation:transfer_ownership')).toBe(role === 'OWNER');
    }
  });

  it('makes VIEWER strictly read-only', () => {
    const writeish = PERMISSIONS.filter(
      (p) =>
        p.endsWith(':write') ||
        p.endsWith(':send') ||
        p.endsWith(':record') ||
        p.endsWith(':void') ||
        p.endsWith(':cancel') ||
        p.endsWith(':archive') ||
        p.endsWith(':convert') ||
        p === 'user:manage' ||
        p === 'role:change' ||
        p === 'organisation:settings',
    );
    for (const permission of writeish) {
      expect(hasPermission('VIEWER', permission)).toBe(false);
    }
    expect(hasPermission('VIEWER', 'invoice:view')).toBe(true);
  });

  it('blocks SALES from payments and invoice mutation', () => {
    expect(hasPermission('SALES', 'payment:record')).toBe(false);
    expect(hasPermission('SALES', 'payment:void')).toBe(false);
    expect(hasPermission('SALES', 'invoice:write')).toBe(false);
    expect(hasPermission('SALES', 'invoice:send')).toBe(false);
  });

  it('gates SALES quotation conversion on organisation settings', () => {
    expect(hasPermission('SALES', 'quotation:convert')).toBe(false);
    expect(
      hasPermission('SALES', 'quotation:convert', { allowSalesConvertQuotation: true }),
    ).toBe(true);
    // The gate must not widen any other role.
    expect(hasPermission('VIEWER', 'quotation:convert', { allowSalesConvertQuotation: true })).toBe(
      false,
    );
  });

  it('blocks BILLING from membership and role administration', () => {
    expect(hasPermission('BILLING', 'user:manage')).toBe(false);
    expect(hasPermission('BILLING', 'role:change')).toBe(false);
    expect(hasPermission('BILLING', 'organisation:transfer_ownership')).toBe(false);
  });

  it('grants BILLING the four conditional permissions at base level', () => {
    // Base grant only — narrowed per-record by checkScopedPermission.
    for (const p of ['invoice:cancel', 'payment:void', 'organisation:settings', 'auditlog:view'] as const) {
      expect(hasPermission('BILLING', p)).toBe(true);
    }
  });
});

describe('scoped permissions (BILLING "Limited" cells)', () => {
  const USER = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';

  it('lets BILLING cancel only DRAFT or SENT invoices', () => {
    for (const status of ['DRAFT', 'SENT']) {
      expect(
        checkScopedPermission('BILLING', { permission: 'invoice:cancel', invoiceStatus: status })
          .allowed,
      ).toBe(true);
    }
    for (const status of ['PAID', 'PARTIALLY_PAID', 'OVERDUE', 'CANCELLED']) {
      expect(
        checkScopedPermission('BILLING', { permission: 'invoice:cancel', invoiceStatus: status })
          .allowed,
      ).toBe(false);
    }
  });

  it('lets OWNER and ADMIN cancel an invoice in any status', () => {
    for (const role of ['OWNER', 'ADMIN'] as const) {
      expect(
        checkScopedPermission(role, { permission: 'invoice:cancel', invoiceStatus: 'PAID' }).allowed,
      ).toBe(true);
    }
  });

  it('lets BILLING void only payments they recorded', () => {
    expect(
      checkScopedPermission('BILLING', {
        permission: 'payment:void',
        paymentCreatedBy: USER,
        actingUserId: USER,
      }).allowed,
    ).toBe(true);

    expect(
      checkScopedPermission('BILLING', {
        permission: 'payment:void',
        paymentCreatedBy: OTHER,
        actingUserId: USER,
      }).allowed,
    ).toBe(false);
  });

  it("lets ADMIN void another user's payment", () => {
    expect(
      checkScopedPermission('ADMIN', {
        permission: 'payment:void',
        paymentCreatedBy: OTHER,
        actingUserId: USER,
      }).allowed,
    ).toBe(true);
  });

  it('restricts BILLING settings changes to the billing group', () => {
    expect(
      checkScopedPermission('BILLING', {
        permission: 'organisation:settings',
        requestedFields: ['invoicePrefix', 'defaultTaxRate', 'defaultPaymentTermsDays'],
      }).allowed,
    ).toBe(true);

    // Branding, security and identity fields are out of scope.
    for (const field of ['logoUrl', 'name', 'taxNumber', 'currencyCode']) {
      expect(
        checkScopedPermission('BILLING', {
          permission: 'organisation:settings',
          requestedFields: [field],
        }).allowed,
      ).toBe(false);
    }

    // A mixed payload is rejected wholesale — no partial application.
    expect(
      checkScopedPermission('BILLING', {
        permission: 'organisation:settings',
        requestedFields: ['invoicePrefix', 'logoUrl'],
      }).allowed,
    ).toBe(false);
  });

  it('restricts BILLING audit reads to financial actions', () => {
    for (const action of ['INVOICE_CREATED', 'QUOTATION_SENT', 'PAYMENT_RECORDED', 'CUSTOMER_CREATED']) {
      expect(
        checkScopedPermission('BILLING', { permission: 'auditlog:view', auditAction: action })
          .allowed,
      ).toBe(true);
    }
    for (const action of ['ROLE_CHANGED', 'USER_DEACTIVATED', 'LOGIN_FAILED', 'PASSWORD_CHANGED']) {
      expect(
        checkScopedPermission('BILLING', { permission: 'auditlog:view', auditAction: action })
          .allowed,
      ).toBe(false);
    }
  });

  it('gives BILLING an audit prefix filter but OWNER/ADMIN none', () => {
    expect(auditActionPrefixFilter('BILLING')).toBeDefined();
    expect(auditActionPrefixFilter('OWNER')).toBeUndefined();
    expect(auditActionPrefixFilter('ADMIN')).toBeUndefined();
  });

  it('denies a role that lacks the base permission outright', () => {
    expect(
      checkScopedPermission('VIEWER', { permission: 'invoice:cancel', invoiceStatus: 'DRAFT' })
        .allowed,
    ).toBe(false);
    expect(
      checkScopedPermission('SALES', {
        permission: 'payment:void',
        paymentCreatedBy: USER,
        actingUserId: USER,
      }).allowed,
    ).toBe(false);
  });

  it('blocks ADMIN from ownership transfer but allows user management', () => {
    expect(hasPermission('ADMIN', 'user:manage')).toBe(true);
    expect(hasPermission('ADMIN', 'organisation:transfer_ownership')).toBe(false);
  });

  it('returns a role permission list that agrees with hasPermission', () => {
    for (const role of ORGANISATION_ROLES) {
      const list = permissionsForRole(role);
      for (const permission of PERMISSIONS) {
        expect(list.includes(permission)).toBe(hasPermission(role, permission));
      }
    }
  });
});
