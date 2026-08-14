import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '@billing/database';
import { ERROR_MESSAGES, type ApiError, type ErrorCode } from '@billing/types';
import { AppError } from '../errors/app-error.js';
import { TenantContextError } from '@billing/database';
import type { AppLogger } from '../logging/logger.js';
import type { AuthenticatedRequest } from '../types/request.js';

/**
 * Single exit point for every error (Security Doc §22).
 *
 * Two layers, strictly separated:
 *   - Client: a stable code and a safe message from ERROR_MESSAGES.
 *   - Log: the full error, stack, user, organisation, and request id.
 *
 * No branch of this filter puts an exception's own message into the response,
 * which is what prevents SQL text, constraint names, or stack traces leaking.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject('APP_LOGGER') private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & AuthenticatedRequest>();
    const requestId = request.requestId ?? 'unknown';

    const { status, code, details, internalDetail } = this.classify(exception);

    const logPayload = {
      requestId,
      method: request.method,
      url: request.originalUrl,
      statusCode: status,
      errorCode: code,
      userId: request.auth?.user.userId,
      organisationId: request.auth?.organisation?.organisationId,
      internalDetail,
      err: exception instanceof Error ? exception : new Error(String(exception)),
    };

    if (status >= 500) {
      this.logger.error(logPayload, 'Request failed');
    } else if (status === 403 || status === 401) {
      // Authorization failures are security-relevant; keep them at warn so
      // they surface in monitoring without drowning in 404 noise.
      this.logger.warn(logPayload, 'Request denied');
    } else {
      this.logger.info(logPayload, 'Request rejected');
    }

    const body: ApiError = {
      error: { code, message: ERROR_MESSAGES[code], ...(details ? { details } : {}) },
      requestId,
    };

    response.status(status).json(body);
  }

  private classify(exception: unknown): {
    status: number;
    code: ErrorCode;
    details?: Array<{ field: string; message: string }>;
    internalDetail?: string;
  } {
    if (exception instanceof AppError) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        details: exception.details,
        internalDetail: exception.internalDetail,
      };
    }

    if (exception instanceof TenantContextError) {
      return {
        status: HttpStatus.FORBIDDEN,
        code: 'FORBIDDEN',
        internalDetail: exception.message,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // Map the few Prisma codes with a meaningful client-facing equivalent;
      // everything else becomes a generic 500 so constraint names stay private.
      switch (exception.code) {
        case 'P2002':
          return {
            status: HttpStatus.CONFLICT,
            code: String(exception.meta?.target ?? '').includes('email')
              ? 'DUPLICATE_EMAIL'
              : 'DUPLICATE_DOCUMENT_NUMBER',
            internalDetail: `Unique constraint on ${String(exception.meta?.target)}`,
          };
        case 'P2025':
          return {
            status: HttpStatus.NOT_FOUND,
            code: 'RESOURCE_NOT_FOUND',
            internalDetail: exception.message,
          };
        case 'P2003':
          return {
            status: HttpStatus.BAD_REQUEST,
            code: 'VALIDATION_ERROR',
            internalDetail: `Foreign key constraint: ${String(exception.meta?.field_name)}`,
          };
        default:
          return {
            status: HttpStatus.INTERNAL_SERVER_ERROR,
            code: 'INTERNAL_ERROR',
            internalDetail: `Prisma ${exception.code}: ${exception.message}`,
          };
      }
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code: ErrorCode =
        status === HttpStatus.UNAUTHORIZED
          ? 'UNAUTHENTICATED'
          : status === HttpStatus.FORBIDDEN
            ? 'FORBIDDEN'
            : status === HttpStatus.NOT_FOUND
              ? 'RESOURCE_NOT_FOUND'
              : status === HttpStatus.TOO_MANY_REQUESTS
                ? 'RATE_LIMITED'
                : status < 500
                  ? 'VALIDATION_ERROR'
                  : 'INTERNAL_ERROR';
      return { status, code, internalDetail: exception.message };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      internalDetail: exception instanceof Error ? exception.message : String(exception),
    };
  }
}
