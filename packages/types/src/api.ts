/**
 * API envelope and error codes.
 * Shapes come from Frontend Spec §16 and Security Doc §22.
 */

export interface ApiSuccess<T> {
  data: T;
  requestId: string;
}

export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level validation detail. Never contains internal state. */
    details?: Array<{ field: string; message: string }>;
  };
  requestId: string;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Stable, machine-readable error codes. The frontend switches on these;
 * user-facing copy may change without breaking clients.
 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'FORBIDDEN',
  'NO_ORGANISATION_CONTEXT',
  'NOT_A_MEMBER',
  'CUSTOMER_NOT_FOUND',
  'QUOTATION_NOT_FOUND',
  'INVOICE_NOT_FOUND',
  'PAYMENT_NOT_FOUND',
  'ORGANISATION_NOT_FOUND',
  'COMPANY_NOT_FOUND',
  'COMPANY_NAME_TAKEN',
  'RESOURCE_NOT_FOUND',
  'DUPLICATE_EMAIL',
  'DUPLICATE_DOCUMENT_NUMBER',
  'INVALID_STATUS_TRANSITION',
  'STALE_RECORD',
  'IDEMPOTENCY_KEY_REUSED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Safe user-facing messages (Security Doc §23).
 *
 * Cross-tenant reads deliberately return the same *_NOT_FOUND message as a
 * genuinely absent record, so response text cannot be used to probe whether
 * an ID exists in another organisation.
 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Please check the highlighted fields and try again.',
  UNAUTHENTICATED: 'Please sign in to continue.',
  SESSION_EXPIRED: 'Your session has expired. Please sign in again.',
  FORBIDDEN: "You don't have permission to perform this action.",
  NO_ORGANISATION_CONTEXT: 'No organisation selected.',
  NOT_A_MEMBER: "You don't have permission to perform this action.",
  CUSTOMER_NOT_FOUND: 'The customer could not be found.',
  QUOTATION_NOT_FOUND: 'The quotation could not be found.',
  INVOICE_NOT_FOUND: 'The invoice could not be found.',
  PAYMENT_NOT_FOUND: 'The payment could not be found.',
  ORGANISATION_NOT_FOUND: 'The organisation could not be found.',
  COMPANY_NOT_FOUND: 'The company could not be found.',
  COMPANY_NAME_TAKEN: 'A company with that name already exists.',
  RESOURCE_NOT_FOUND: 'The requested item could not be found.',
  DUPLICATE_EMAIL: 'An account with this email already exists.',
  DUPLICATE_DOCUMENT_NUMBER: 'That document number is already in use.',
  INVALID_STATUS_TRANSITION: 'That action is not allowed for the current status.',
  STALE_RECORD: 'This record changed since you opened it. Please refresh and try again.',
  IDEMPOTENCY_KEY_REUSED: 'This request was already processed.',
  RATE_LIMITED: 'Too many requests. Please try again later.',
  INTERNAL_ERROR: 'Something went wrong. Please try again.',
};
