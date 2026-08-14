import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedRequest, AuthContext } from '../types/request.js';
import type { OrganisationContext } from '@billing/types';
import { noOrganisationContext, unauthenticated } from '../errors/app-error.js';

/** The authenticated user + session. Throws if the guard did not run. */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const request = context.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    if (!request.auth) throw unauthenticated('Guard did not populate auth context');
    return request.auth;
  },
);

/**
 * The verified organisation context.
 *
 * Because this can only be populated by OrganisationGuard after a membership
 * lookup, a controller that takes this parameter cannot accidentally operate
 * on an unverified tenant.
 */
export const CurrentOrganisation = createParamDecorator(
  (_data: unknown, context: ExecutionContext): OrganisationContext => {
    const request = context.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    if (!request.auth?.organisation) throw noOrganisationContext();
    return request.auth.organisation;
  },
);

export const RequestId = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const request = context.switchToHttp().getRequest<Request & AuthenticatedRequest>();
  return request.requestId ?? 'unknown';
});
