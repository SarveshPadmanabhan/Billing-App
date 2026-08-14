import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import type { Request } from 'express';
import { Prisma } from '@billing/database';
import type { AuthenticatedRequest } from '../types/request.js';

/**
 * Serialise values JSON.stringify cannot handle natively.
 *
 *   - BigInt (document sequence counters) -> string. A number would silently
 *     lose precision beyond 2^53.
 *   - Prisma.Decimal (every money column) -> string, NOT number. This is the
 *     rule that keeps financial values exact across the wire: a JSON number
 *     is an IEEE-754 double and would reintroduce the rounding error the
 *     NUMERIC(19,4) column exists to prevent (Security Doc §16).
 */
function serialise(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialise);

  if (typeof value === 'object') {
    // Leave class instances other than the above untouched.
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      const plain: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) plain[key] = serialise(entry);
      return plain;
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) output[key] = serialise(entry);
    return output;
  }

  return value;
}

/**
 * Wraps every successful response as { data, requestId } (Frontend Spec §16).
 * Handlers return plain payloads; the envelope is applied here so it cannot be
 * forgotten or shaped inconsistently per controller.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, { data: unknown; requestId: string }> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<{ data: unknown; requestId: string }> {
    const request = context.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    const requestId = request.requestId ?? 'unknown';
    return next.handle().pipe(map((data) => ({ data: serialise(data), requestId })));
  }
}
