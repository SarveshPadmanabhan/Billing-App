/**
 * Roles and the permission matrix.
 *
 * Source of truth: Security & Access Document §12.
 * This module is pure data + pure functions so it can be unit-tested and
 * shared by the API (enforcement) and the web app (UI affordances only).
 *
 * The frontend uses this to decide what to *show*. The API uses it to decide
 * what to *allow*. Hiding a button is not security — the API check is the
 * real one (Security Doc §12: "Backend enforcement is mandatory").
 */

export const ORGANISATION_ROLES = ['OWNER', 'ADMIN', 'BILLING', 'SALES', 'VIEWER'] as const;
export type OrganisationRole = (typeof ORGANISATION_ROLES)[number];

export const PERMISSIONS = [
  'dashboard:view',
  'customer:view',
  'customer:write',
  'customer:archive',
  'quotation:view',
  'quotation:write',
  'quotation:send',
  'quotation:convert',
  'invoice:view',
  'invoice:write',
  'invoice:send',
  'invoice:cancel',
  'payment:view',
  'payment:record',
  'payment:void',
  'report:view',
  'user:manage',
  'role:change',
  'organisation:settings',
  'auditlog:view',
  'organisation:transfer_ownership',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Matrix from Security Doc §12.
 *
 * Two deliberate readings of that table, flagged for review:
 *
 * 1. "Convert quotation" is "Config" for SALES — configurable per organisation.
 *    Encoded as a base deny, overridable by
 *    organisation_settings.allow_sales_convert_quotation. See `hasPermission`.
 *
 * 2. "Limited" appears for BILLING (cancel invoice, void payment,
 *    organisation settings, audit logs) and for SALES/VIEWER (reports).
 *    "Limited" is not a permission level, so each is resolved to a concrete
 *    grant or deny below and noted. Confirm these before Phase 2.
 */
const MATRIX: Record<OrganisationRole, ReadonlySet<Permission>> = {
  OWNER: new Set(PERMISSIONS),

  ADMIN: new Set<Permission>([
    'dashboard:view',
    'customer:view',
    'customer:write',
    'customer:archive',
    'quotation:view',
    'quotation:write',
    'quotation:send',
    'quotation:convert',
    'invoice:view',
    'invoice:write',
    'invoice:send',
    'invoice:cancel',
    'payment:view',
    'payment:record',
    'payment:void',
    'report:view',
    'user:manage',
    'role:change',
    'organisation:settings',
    'auditlog:view',
    // Excludes organisation:transfer_ownership — OWNER only (§8).
  ]),

  BILLING: new Set<Permission>([
    'dashboard:view',
    'customer:view',
    'customer:write',
    'customer:archive',
    'quotation:view',
    'quotation:write',
    'quotation:send',
    'quotation:convert',
    'invoice:view',
    'invoice:write',
    'invoice:send',
    'payment:view',
    'payment:record',
    'report:view',
    // The four "Limited" cells in Security Doc §12 are granted here as base
    // permissions but are CONDITIONAL for BILLING — each is narrowed by
    // `checkScopedPermission` below, which the API must call at the point of
    // action because the limit depends on record state or ownership:
    //   invoice:cancel        -> only DRAFT or SENT invoices
    //   payment:void          -> only payments this user recorded
    //   organisation:settings -> only billing settings, not branding/users/security
    //   auditlog:view         -> only invoice/quotation/payment entries
    'invoice:cancel',
    'payment:void',
    'organisation:settings',
    'auditlog:view',
  ]),

  SALES: new Set<Permission>([
    'dashboard:view',
    'customer:view',
    'customer:write',
    'quotation:view',
    'quotation:write',
    'quotation:send',
    'invoice:view', // §10 allows viewing; modifying issued invoices is denied.
    'report:view', // "Limited" — scoped to quotation reports in Phase 2.
    // quotation:convert is config-gated; see hasPermission().
  ]),

  VIEWER: new Set<Permission>([
    'dashboard:view',
    'customer:view',
    'quotation:view',
    'invoice:view',
    'payment:view',
    'report:view', // "Limited" — read-only reports.
  ]),
};

export interface PermissionContext {
  /** organisation_settings.allow_sales_convert_quotation */
  allowSalesConvertQuotation?: boolean;
}

export function hasPermission(
  role: OrganisationRole,
  permission: Permission,
  context: PermissionContext = {},
): boolean {
  if (role === 'SALES' && permission === 'quotation:convert') {
    return context.allowSalesConvertQuotation === true;
  }
  return MATRIX[role].has(permission);
}

export function permissionsForRole(
  role: OrganisationRole,
  context: PermissionContext = {},
): Permission[] {
  return PERMISSIONS.filter((permission) => hasPermission(role, permission, context));
}

export function isOrganisationRole(value: unknown): value is OrganisationRole {
  return typeof value === 'string' && (ORGANISATION_ROLES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Scoped permissions
//
// Four permissions are "Limited" for BILLING in Security Doc §12. The limit
// depends on the specific record, so `hasPermission` alone cannot decide it —
// it answers "may this role ever do this?", while `checkScopedPermission`
// answers "may this role do this to THIS record?".
//
// Any endpoint guarding one of these four MUST call the scoped check after
// loading the record. `@RequirePermission` on its own is not sufficient.
// ---------------------------------------------------------------------------

/** Settings groups. BILLING may change only the billing group. */
export const SETTINGS_GROUPS = ['billing', 'branding', 'users', 'security'] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

/**
 * Which organisation_settings / organisation columns belong to which group.
 * Used to reject a settings PATCH that reaches outside the caller's scope.
 */
export const BILLING_SETTINGS_FIELDS = [
  'invoicePrefix',
  'quotationPrefix',
  'invoiceStartNumber',
  'quotationStartNumber',
  'numberPadding',
  'defaultPaymentTermsDays',
  'defaultTaxRate',
  'defaultNotes',
  'defaultTerms',
  'dateFormat',
] as const;

/** Audit actions BILLING may read: financial documents only, never security. */
const BILLING_VISIBLE_AUDIT_PREFIXES = ['INVOICE_', 'QUOTATION_', 'PAYMENT_', 'CUSTOMER_'] as const;

export type ScopedPermissionInput =
  | {
      permission: 'invoice:cancel';
      /** Current status of the invoice being cancelled. */
      invoiceStatus: string;
    }
  | {
      permission: 'payment:void';
      /** users.id that created the payment. */
      paymentCreatedBy: string;
      /** The acting user. */
      actingUserId: string;
    }
  | {
      permission: 'organisation:settings';
      /** Setting keys the request is attempting to change. */
      requestedFields: readonly string[];
    }
  | {
      permission: 'auditlog:view';
      /** Audit action being read, or the filter being requested. */
      auditAction: string;
    };

export interface ScopedPermissionResult {
  allowed: boolean;
  /** Machine-readable reason for denial; safe to log, not to return verbatim. */
  reason?: string;
}

const ALLOWED = { allowed: true } as const;

/**
 * Second-stage check for the four conditional permissions.
 *
 * OWNER and ADMIN pass unconditionally — their §7/§8 grants are unrestricted.
 * SALES and VIEWER never hold these permissions at all, so they are denied by
 * `hasPermission` before reaching here; the guard below is belt-and-braces.
 */
export function checkScopedPermission(
  role: OrganisationRole,
  input: ScopedPermissionInput,
  context: PermissionContext = {},
): ScopedPermissionResult {
  // Must hold the base permission first.
  if (!hasPermission(role, input.permission, context)) {
    return { allowed: false, reason: `Role ${role} lacks ${input.permission}` };
  }

  // Unrestricted for OWNER/ADMIN (Security Doc §7, §8).
  if (role === 'OWNER' || role === 'ADMIN') return ALLOWED;

  // Only BILLING reaches here for these four permissions.
  switch (input.permission) {
    case 'invoice:cancel': {
      // BILLING may cancel only before money has moved. Cancelling a
      // PAID/PARTIALLY_PAID invoice rewrites settled financial history and is
      // reserved for OWNER/ADMIN.
      const cancellable = input.invoiceStatus === 'DRAFT' || input.invoiceStatus === 'SENT';
      return cancellable
        ? ALLOWED
        : {
            allowed: false,
            reason: `BILLING may cancel only DRAFT or SENT invoices, not ${input.invoiceStatus}`,
          };
    }

    case 'payment:void': {
      // BILLING may void only their own entries — correcting one's own
      // mistake, not reversing a colleague's.
      return input.paymentCreatedBy === input.actingUserId
        ? ALLOWED
        : { allowed: false, reason: 'BILLING may void only payments they recorded' };
    }

    case 'organisation:settings': {
      const outside = input.requestedFields.filter(
        (field) => !(BILLING_SETTINGS_FIELDS as readonly string[]).includes(field),
      );
      return outside.length === 0
        ? ALLOWED
        : {
            allowed: false,
            reason: `BILLING may not change non-billing settings: ${outside.join(', ')}`,
          };
    }

    case 'auditlog:view': {
      const visible = BILLING_VISIBLE_AUDIT_PREFIXES.some((prefix) =>
        input.auditAction.startsWith(prefix),
      );
      return visible
        ? ALLOWED
        : {
            allowed: false,
            reason: `BILLING may not read audit action ${input.auditAction}`,
          };
    }
  }
}

/**
 * Audit-action filter for BILLING list queries.
 * Returns undefined when the role may see everything.
 */
export function auditActionPrefixFilter(role: OrganisationRole): readonly string[] | undefined {
  if (role === 'OWNER' || role === 'ADMIN') return undefined;
  return BILLING_VISIBLE_AUDIT_PREFIXES;
}
