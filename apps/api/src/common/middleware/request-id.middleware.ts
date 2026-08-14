import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../types/request.js';

/**
 * Assigns a request id used in logs, error envelopes, and audit rows so a user
 * report can be traced to exact log lines (Tech Arch Doc §19).
 *
 * A client-supplied X-Request-Id is accepted only if it looks like a safe
 * token — otherwise a hostile value could forge or corrupt log entries.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & AuthenticatedRequest, res: Response, next: NextFunction): void {
    const supplied = req.headers['x-request-id'];
    const candidate = Array.isArray(supplied) ? supplied[0] : supplied;

    req.requestId =
      candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : `req_${randomUUID()}`;

    res.setHeader('X-Request-Id', req.requestId);
    next();
  }
}
