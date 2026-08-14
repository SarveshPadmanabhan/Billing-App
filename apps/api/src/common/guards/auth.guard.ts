import { Injectable, CanActivate, ExecutionContext, Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../../auth/auth.config.js';
import { unauthenticated, sessionExpired, forbidden } from '../errors/app-error.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import type { AuthenticatedRequest } from '../types/request.js';

/**
 * Step 1 of the check chain (Security Doc §13): is the caller authenticated?
 *
 * Resolves the session from the HTTP-only cookie via Better Auth. Nothing is
 * read from the request body or from client-controlled headers.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  // Injected explicitly by token: tsx/esbuild does not emit the design-time
  // parameter metadata Nest normally uses to resolve constructor types.
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & AuthenticatedRequest>();

    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });

    if (!session?.user) {
      throw unauthenticated('No valid session cookie');
    }

    if (session.session.expiresAt && new Date(session.session.expiresAt) < new Date()) {
      throw sessionExpired();
    }

    // A user deactivated mid-session must lose access immediately, not at
    // token expiry (Security Doc §25: "Deactivated account").
    if ((session.user as { isActive?: boolean }).isActive === false) {
      throw forbidden('User account is deactivated');
    }

    request.auth = {
      user: {
        userId: session.user.id,
        email: session.user.email,
        firstName: (session.user as { firstName?: string }).firstName ?? '',
        lastName: (session.user as { lastName?: string | null }).lastName ?? null,
        avatarUrl: session.user.image ?? null,
        emailVerified: Boolean(session.user.emailVerified),
      },
      sessionId: session.session.id,
      // Server-side only: set by the organisation-switch endpoint after
      // membership is verified. Never populated from client input.
      activeOrganisationId:
        (session.session as { activeOrganisationId?: string | null }).activeOrganisationId ?? null,
      organisation: null,
    };

    return true;
  }
}
