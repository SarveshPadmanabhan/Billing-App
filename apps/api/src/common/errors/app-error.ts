import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_MESSAGES, type ErrorCode } from '@billing/types';

/**
 * Application error carrying a stable machine-readable code.
 *
 * The message sent to the client always comes from the ERROR_MESSAGES table —
 * never from an exception's own text — so internal details (SQL, stack traces,
 * whether a record exists in another tenant) cannot leak (Security Doc §22).
 * Diagnostic context travels in `internalDetail`, which is logged, not returned.
 */
export class AppError extends HttpException {
  readonly code: ErrorCode;
  readonly internalDetail?: string;
  readonly details?: Array<{ field: string; message: string }>;

  constructor(
    code: ErrorCode,
    status: HttpStatus,
    options?: {
      internalDetail?: string;
      details?: Array<{ field: string; message: string }>;
    },
  ) {
    super(ERROR_MESSAGES[code], status);
    this.code = code;
    this.internalDetail = options?.internalDetail;
    this.details = options?.details;
  }
}

export const unauthenticated = (detail?: string) =>
  new AppError('UNAUTHENTICATED', HttpStatus.UNAUTHORIZED, { internalDetail: detail });

export const sessionExpired = () => new AppError('SESSION_EXPIRED', HttpStatus.UNAUTHORIZED);

export const forbidden = (detail?: string) =>
  new AppError('FORBIDDEN', HttpStatus.FORBIDDEN, { internalDetail: detail });

export const noOrganisationContext = () =>
  new AppError('NO_ORGANISATION_CONTEXT', HttpStatus.FORBIDDEN);

/**
 * Cross-tenant access returns 404, not 403.
 *
 * A 403 would confirm the record exists — turning the endpoint into an oracle
 * for probing other organisations' UUIDs. Security Doc §23: "Use the same
 * general response for records belonging to another organisation."
 */
export const notFound = (code: ErrorCode, detail?: string) =>
  new AppError(code, HttpStatus.NOT_FOUND, { internalDetail: detail });

export const validationFailed = (details: Array<{ field: string; message: string }>) =>
  new AppError('VALIDATION_ERROR', HttpStatus.BAD_REQUEST, { details });

export const conflict = (code: ErrorCode, detail?: string) =>
  new AppError(code, HttpStatus.CONFLICT, { internalDetail: detail });

export const internalError = (detail?: string) =>
  new AppError('INTERNAL_ERROR', HttpStatus.INTERNAL_SERVER_ERROR, { internalDetail: detail });
