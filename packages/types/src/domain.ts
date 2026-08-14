/**
 * Domain enums and lifecycle rules.
 * Statuses from Technical Architecture Doc §8; transitions from Security Doc §17–18.
 *
 * Money is represented as a decimal *string* across every boundary (API, jobs,
 * serialisation). Never `number` — IEEE-754 cannot represent 0.1 exactly, and
 * a rounding drift in a billing total is a financial defect. Convert to
 * decimal.js at the edge and back to string on the way out.
 */
export type MoneyString = string;

export const INVOICE_STATUSES = [
  'DRAFT',
  'SENT',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'CANCELLED',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const QUOTATION_STATUSES = [
  'DRAFT',
  'SENT',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'CONVERTED',
  'CANCELLED',
] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

export const PAYMENT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'CARD',
  'CHEQUE',
  'UPI',
  'OTHER',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['RECORDED', 'VOIDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const CUSTOMER_TYPES = ['INDIVIDUAL', 'COMPANY'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const DOCUMENT_TYPES = ['INVOICE', 'QUOTATION'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * Allowed invoice transitions. Anything absent is rejected — notably
 * PAID -> DRAFT and any other backward move (Security Doc §17).
 *
 * OVERDUE is reachable from SENT/PARTIALLY_PAID and is set by a scheduled job,
 * not by a user action. It can still progress to PAID or CANCELLED.
 */
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED'],
  PARTIALLY_PAID: ['PAID', 'OVERDUE', 'CANCELLED'],
  OVERDUE: ['PARTIALLY_PAID', 'PAID', 'CANCELLED'],
  PAID: [], // Terminal. Corrections happen via credit note (post-V1).
  CANCELLED: [], // Terminal.
};

export const QUOTATION_TRANSITIONS: Record<QuotationStatus, readonly QuotationStatus[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  ACCEPTED: ['CONVERTED', 'EXPIRED', 'CANCELLED'],
  REJECTED: [], // Terminal.
  EXPIRED: [], // Terminal.
  CONVERTED: [], // Terminal — guards against double conversion (§18).
  CANCELLED: [], // Terminal.
};

export function canTransitionInvoice(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[from].includes(to);
}

export function canTransitionQuotation(from: QuotationStatus, to: QuotationStatus): boolean {
  return QUOTATION_TRANSITIONS[from].includes(to);
}

/** Issued documents are cancelled, never hard-deleted (Security Doc §17). */
export function isEditableInvoiceStatus(status: InvoiceStatus): boolean {
  return status === 'DRAFT';
}

export function isEditableQuotationStatus(status: QuotationStatus): boolean {
  return status === 'DRAFT';
}

/** Audit actions from Security Doc §21. */
export const AUDIT_ACTIONS = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILED',
  'LOGOUT',
  'PASSWORD_CHANGED',
  'USER_REGISTERED',
  'USER_INVITED',
  'USER_DEACTIVATED',
  'ROLE_CHANGED',
  'ORGANISATION_CREATED',
  'ORGANISATION_UPDATED',
  'CUSTOMER_CREATED',
  'CUSTOMER_UPDATED',
  'CUSTOMER_ARCHIVED',
  'QUOTATION_CREATED',
  'QUOTATION_UPDATED',
  'QUOTATION_CANCELLED',
  'QUOTATION_EXPIRED',
  'QUOTATION_DUPLICATED',
  'QUOTATION_SENT',
  'QUOTATION_ACCEPTED',
  'QUOTATION_REJECTED',
  'QUOTATION_CONVERTED',
  'INVOICE_CREATED',
  'INVOICE_UPDATED',
  'INVOICE_DUPLICATED',
  'INVOICE_SENT',
  'INVOICE_CANCELLED',
  'PAYMENT_RECORDED',
  'PAYMENT_VOIDED',
  'TENANT_ISOLATION_VIOLATION',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
