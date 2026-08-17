import { Injectable, CanActivate, ExecutionContext, Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { withTenant, withUser } from '@billing/database';
import { hasPermission, type Permission, isOrganisationRole } from '@billing/types';
import { forbidden, noOrganisationContext } from '../errors/app-error.js';
import { REQUIRED_PERMISSION_KEY } from '../decorators/require-permission.decorator.js';
import { ALLOW_NO_ORG_KEY } from '../decorators/allow-no-organisation.decorator.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import type { AuthenticatedRequest } from '../types/request.js';

/**
 * Steps 2 and 3 of the check chain (Security Doc §13):
 *   2. Does the user belong to an organisation?
 *   3. Does their role permit this action?
 *
 * TICKET-007. The critical property: organisation context comes ONLY from the
 * session row, which the client cannot write. Any organisation id in the URL,
 * body, query string, or a header like X-Organisation-Id is ignored — and if
 * it disagrees with the session, the request is rejected outright rather than
 * silently using the trusted value, so probing shows up in the audit log.
 */
@Injectable()
export class OrganisationGuard implements CanActivate {
  // Injected by token — see AuthGuard for why.
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    const auth = request.auth;
    if (!auth) throw noOrganisationContext();

    const allowNoOrg = this.reflector.getAllAndOverride<boolean>(ALLOW_NO_ORG_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Reject any client-supplied organisation id that contradicts the session.
    //
    // Skipped for routes marked AllowNoOrganisation: switch-organisation
    // legitimately takes a target organisation in its body, and it performs its
    // own membership check before writing the session. Applying the forgery
    // rule there would make switching impossible.
    if (!allowNoOrg) {
      this.rejectForgedOrganisationId(request, auth.activeOrganisationId);
    }

    if (!auth.activeOrganisationId) {
      // Routes like "create organisation" and "list my memberships" legitimately
      // run before any organisation is selected.
      if (allowNoOrg) return true;
      throw noOrganisationContext();
    }

    // Membership is re-read per request, so removing a user or changing their
    // role takes effect immediately rather than at next login
    // (Security Doc §26: "User removed while logged in").
    //
    // Runs with USER context, not tenant context: this is the query that
    // establishes the tenant, so it cannot itself be tenant-scoped. RLS still
    // applies via membership_visibility (user_id = current_user_id()), so it
    // can only ever return the caller's own membership row.
    const membership = await withUser(auth.user.userId, (tx) =>
      tx.organisationMember.findUnique({
        where: {
          organisationId_userId: {
            organisationId: auth.activeOrganisationId!,
            userId: auth.user.userId,
          },
        },
        select: {
          id: true,
          role: true,
          isActive: true,
          organisation: { select: { id: true, name: true } },
        },
      }),
    );

    if (!membership || !membership.isActive) {
      throw forbidden(
        `User ${auth.user.userId} is not an active member of ${auth.activeOrganisationId}`,
      );
    }

    if (!isOrganisationRole(membership.role)) {
      throw forbidden(`Unrecognised role on membership ${membership.id}`);
    }

    // Resolve the active company. The session may name one; otherwise fall
    // back to the organisation's default. A named company is verified to
    // belong to this organisation before use — a client-supplied id is never
    // trusted, exactly as with organisationId.
    const company = await withTenant(membership.organisation.id, async (tx) => {
      if (auth.activeCompanyId) {
        const named = await tx.company.findFirst({
          where: {
            id: auth.activeCompanyId,
            organisationId: membership.organisation.id,
            isArchived: false,
          },
          select: { id: true, name: true },
        });
        if (named) return named;
      }
      return tx.company.findFirst({
        where: { organisationId: membership.organisation.id, isDefault: true },
        select: { id: true, name: true },
      });
    });

    if (!company) {
      throw forbidden(`Organisation ${membership.organisation.id} has no usable company`);
    }

    auth.organisation = {
      organisationId: membership.organisation.id,
      organisationName: membership.organisation.name,
      role: membership.role,
      membershipId: membership.id,
      companyId: company.id,
      companyName: company.name,
    };

    const required = this.reflector.getAllAndOverride<Permission>(REQUIRED_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required) {
      // Tenant is verified by this point, so this read runs scoped.
      const settings = await withTenant(membership.organisation.id, (tx) =>
        tx.organisationSettings.findUnique({
          where: { organisationId: membership.organisation.id },
          select: { allowSalesConvertQuotation: true },
        }),
      );

      const permitted = hasPermission(membership.role, required, {
        allowSalesConvertQuotation: settings?.allowSalesConvertQuotation ?? false,
      });

      if (!permitted) {
        throw forbidden(
          `Role ${membership.role} lacks ${required} in organisation ${membership.organisation.id}`,
        );
      }
    }

    return true;
  }

  /**
   * A request may *name* an organisation (e.g. /organisations/:id), but it must
   * match the session's. Mismatch is treated as an attack, not a mistake.
   */
  private rejectForgedOrganisationId(
    request: Request & AuthenticatedRequest,
    sessionOrganisationId: string | null,
  ): void {
    const candidates = [
      (request.headers['x-organisation-id'] as string | undefined),
      (request.headers['x-org-id'] as string | undefined),
      (request.params as Record<string, string> | undefined)?.organisationId,
      (request.query as Record<string, unknown> | undefined)?.organisationId,
      (request.body as Record<string, unknown> | undefined)?.organisationId,
    ];

    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate.length === 0) continue;
      if (candidate !== sessionOrganisationId) {
        throw forbidden(
          `Client supplied organisation id ${candidate} that does not match session context`,
        );
      }
    }
  }
}
