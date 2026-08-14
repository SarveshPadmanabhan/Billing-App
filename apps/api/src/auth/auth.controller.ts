import { Controller, Get, Post, Req, Body, Inject } from '@nestjs/common';
import type { Request } from 'express';
import { prisma, withTenant, withUser, withoutTenant } from '@billing/database';
import { permissionsForRole, type CurrentUserResponse, type OrganisationRole } from '@billing/types';
import { AllowNoOrganisation } from '../common/decorators/allow-no-organisation.decorator.js';
import { CurrentAuth } from '../common/decorators/current-context.decorator.js';
import type { AuthContext } from '../common/types/request.js';
import { AuditService } from '../common/audit/audit.service.js';
import { notFound } from '../common/errors/app-error.js';
import { uuidSchema } from '@billing/validation';

/**
 * TICKET-003 (registration) and TICKET-004 (login/logout/session).
 *
 * Registration, login, logout, verification, and password reset are handled by
 * Better Auth's mounted handler — we do not re-implement credential flows.
 * This controller adds what the product needs on top: /me with organisation
 * context and permissions, organisation switching, and audit logging.
 */
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  // Better Auth's own endpoints (/sign-up/email, /sign-in/email, /sign-out,
  // /verify-email, /reset-password, ...) are mounted as Express middleware in
  // main.ts, ahead of the Nest router. Mounting them there rather than as a
  // Nest wildcard route keeps Better Auth's internal routing intact and avoids
  // the body being consumed by Nest's JSON parser before it sees the request.

  /**
   * Current user + active organisation + permissions (Frontend Spec §17).
   * Allowed without organisation context — a freshly registered user has none.
   */
  @AllowNoOrganisation()
  @Get('me')
  async me(@CurrentAuth() authContext: AuthContext): Promise<CurrentUserResponse> {
    const memberships = await withUser(authContext.user.userId, (tx) =>
      tx.organisationMember.findMany({
        where: { userId: authContext.user.userId, isActive: true },
        select: {
          organisationId: true,
          role: true,
          organisation: { select: { name: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );

    const active = authContext.activeOrganisationId
      ? memberships.find((m) => m.organisationId === authContext.activeOrganisationId)
      : undefined;

    let organisation: CurrentUserResponse['organisation'] = null;

    if (active) {
      // Membership already confirmed above, so this read is tenant-scoped.
      const settings = await withTenant(active.organisationId, (tx) =>
        tx.organisationSettings.findUnique({
          where: { organisationId: active.organisationId },
          select: { allowSalesConvertQuotation: true },
        }),
      );

      organisation = {
        organisationId: active.organisationId,
        organisationName: active.organisation.name,
        role: active.role as OrganisationRole,
        membershipId: '',
        permissions: permissionsForRole(active.role as OrganisationRole, {
          allowSalesConvertQuotation: settings?.allowSalesConvertQuotation ?? false,
        }),
      };
    }

    return {
      user: authContext.user,
      organisation,
      memberships: memberships.map((m) => ({
        organisationId: m.organisationId,
        organisationName: m.organisation.name,
        role: m.role as OrganisationRole,
      })),
    };
  }

  /**
   * Switch the active organisation.
   *
   * This is the ONLY way session.activeOrganisationId is ever written, and it
   * writes only after confirming an active membership. That is what makes the
   * session a trustworthy source of tenant context everywhere else.
   */
  @AllowNoOrganisation()
  @Post('switch-organisation')
  async switchOrganisation(
    @CurrentAuth() authContext: AuthContext,
    @Body('organisationId') rawOrganisationId: unknown,
    @Req() req: Request,
  ) {
    const parsed = uuidSchema.safeParse(rawOrganisationId);
    if (!parsed.success) {
      throw notFound('ORGANISATION_NOT_FOUND', 'Malformed organisation id on switch');
    }
    const organisationId = parsed.data;

    const membership = await withUser(authContext.user.userId, (tx) =>
      tx.organisationMember.findUnique({
        where: {
          organisationId_userId: { organisationId, userId: authContext.user.userId },
        },
        select: { role: true, isActive: true, organisation: { select: { id: true, name: true } } },
      }),
    );

    // Same 404 whether the organisation is absent or simply not ours — a 403
    // here would confirm the organisation exists.
    if (!membership || !membership.isActive) {
      throw notFound(
        'ORGANISATION_NOT_FOUND',
        `User ${authContext.user.userId} attempted to switch into ${organisationId} without membership`,
      );
    }

    await prisma.session.update({
      where: { id: authContext.sessionId },
      data: { activeOrganisationId: organisationId },
    });

    await this.audit.recordDetached({
      organisationId,
      userId: authContext.user.userId,
      action: 'LOGIN_SUCCESS',
      entityType: 'organisation',
      entityId: organisationId,
      newValues: { switchedTo: organisationId },
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    return {
      organisationId,
      organisationName: membership.organisation.name,
      role: membership.role,
    };
  }

  /** Sessions for this user — supports "log out of all devices". */
  @AllowNoOrganisation()
  @Get('sessions')
  async sessions(@CurrentAuth() authContext: AuthContext) {
    const rows = await prisma.session.findMany({
      where: { userId: authContext.user.userId, expiresAt: { gt: new Date() } },
      select: { id: true, createdAt: true, expiresAt: true, ipAddress: true, userAgent: true },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => ({ ...row, current: row.id === authContext.sessionId }));
  }

  @AllowNoOrganisation()
  @Post('revoke-other-sessions')
  async revokeOtherSessions(@CurrentAuth() authContext: AuthContext, @Req() req: Request) {
    const result = await prisma.session.deleteMany({
      where: { userId: authContext.user.userId, id: { not: authContext.sessionId } },
    });

    await this.audit.recordDetached({
      organisationId: authContext.activeOrganisationId,
      userId: authContext.user.userId,
      action: 'LOGOUT',
      entityType: 'session',
      newValues: { revokedCount: result.count },
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    return { revoked: result.count };
  }
}
