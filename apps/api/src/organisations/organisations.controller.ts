import { Controller, Get, Post, Patch, Body, Req, Inject } from '@nestjs/common';
import type { Request } from 'express';
import { prisma, withTenant, createDocumentSequences } from '@billing/database';
import {
  createOrganisationSchema,
  updateOrganisationSchema,
  type CreateOrganisationInput,
  type UpdateOrganisationInput,
} from '@billing/validation';
import { zodPipe } from '../common/pipes/zod-validation.pipe.js';
import { AllowNoOrganisation } from '../common/decorators/allow-no-organisation.decorator.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { CurrentAuth, CurrentOrganisation } from '../common/decorators/current-context.decorator.js';
import type { AuthContext } from '../common/types/request.js';
import type { OrganisationContext } from '@billing/types';
import { AuditService } from '../common/audit/audit.service.js';
import { forbidden, notFound } from '../common/errors/app-error.js';

/**
 * TICKET-005 — organisation creation and onboarding.
 */
@Controller({ path: 'organisations', version: '1' })
export class OrganisationsController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  /**
   * Create an organisation. The creator becomes OWNER.
   *
   * One transaction covers organisation + settings + OWNER membership +
   * both document sequences + audit row. A partial failure must not leave an
   * organisation with no owner or no numbering (Tech Arch Doc §11).
   */
  @AllowNoOrganisation()
  @Post()
  async create(
    @CurrentAuth() authContext: AuthContext,
    @Body(zodPipe(createOrganisationSchema)) input: CreateOrganisationInput,
    @Req() req: Request,
  ) {
    const organisationId = crypto.randomUUID();

    const organisation = await withTenant(
      organisationId,
      async (tx) => {
      const created = await tx.organisation.create({
        data: {
          id: organisationId,
          name: input.name,
          legalName: input.legalName ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          website: input.website || null,
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          postalCode: input.postalCode ?? null,
          countryCode: input.countryCode,
          taxNumber: input.taxNumber ?? null,
          currencyCode: input.currencyCode,
          timezone: input.timezone,
          settings: {
            create: {
              invoicePrefix: input.invoicePrefix,
              quotationPrefix: input.quotationPrefix,
              invoiceStartNumber: BigInt(input.invoiceStartNumber),
              quotationStartNumber: BigInt(input.quotationStartNumber),
              numberPadding: 6,
              defaultPaymentTermsDays: input.defaultPaymentTermsDays,
              defaultTaxRate: input.defaultTaxRate,
              defaultNotes: input.defaultNotes ?? null,
              defaultTerms: input.defaultTerms ?? null,
              dateFormat: input.dateFormat,
            },
          },
          members: {
            create: {
              userId: authContext.user.userId,
              role: 'OWNER', // Creator is always OWNER (TICKET-005).
              isActive: true,
            },
          },
        },
        select: { id: true, name: true, currencyCode: true, countryCode: true, createdAt: true },
      });

      await createDocumentSequences(tx, organisationId, {
        invoicePrefix: input.invoicePrefix,
        quotationPrefix: input.quotationPrefix,
        invoiceStartNumber: BigInt(input.invoiceStartNumber),
        quotationStartNumber: BigInt(input.quotationStartNumber),
        padding: 6,
      });

      await this.audit.record(tx, {
        organisationId,
        userId: authContext.user.userId,
        action: 'ORGANISATION_CREATED',
        entityType: 'organisation',
        entityId: organisationId,
        newValues: { name: input.name, currencyCode: input.currencyCode },
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        requestId: (req as { requestId?: string }).requestId ?? null,
      });

        return created;
      },
      undefined,
      // User context is required so the OWNER membership INSERT satisfies the
      // membership policies alongside the tenant policy.
      { userId: authContext.user.userId },
    );

    // Select the new organisation for this session so the client can proceed
    // straight into the app.
    await prisma.session.update({
      where: { id: authContext.sessionId },
      data: { activeOrganisationId: organisationId },
    });

    return { ...organisation, role: 'OWNER' as const };
  }

  /** The caller's active organisation. Scoped by the guard + RLS. */
  @Get('current')
  async current(@CurrentOrganisation() org: OrganisationContext) {
    const organisation = await withTenant(org.organisationId, (tx) =>
      tx.organisation.findUnique({
        where: { id: org.organisationId },
        include: { settings: true },
      }),
    );

    if (!organisation) {
      throw notFound('ORGANISATION_NOT_FOUND', `Organisation ${org.organisationId} vanished`);
    }

    return { ...organisation, role: org.role };
  }

  @RequirePermission('organisation:settings')
  @Patch('current')
  async update(
    @CurrentAuth() authContext: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Body(zodPipe(updateOrganisationSchema)) input: UpdateOrganisationInput,
    @Req() req: Request,
  ) {
    return withTenant(org.organisationId, async (tx) => {
      const before = await tx.organisation.findUnique({
        where: { id: org.organisationId },
        include: { settings: true },
      });
      if (!before) {
        throw notFound('ORGANISATION_NOT_FOUND');
      }

      const updated = await tx.organisation.update({
        where: { id: org.organisationId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.legalName !== undefined && { legalName: input.legalName }),
          ...(input.email !== undefined && { email: input.email }),
          ...(input.phone !== undefined && { phone: input.phone }),
          ...(input.website !== undefined && { website: input.website || null }),
          ...(input.addressLine1 !== undefined && { addressLine1: input.addressLine1 }),
          ...(input.addressLine2 !== undefined && { addressLine2: input.addressLine2 }),
          ...(input.city !== undefined && { city: input.city }),
          ...(input.state !== undefined && { state: input.state }),
          ...(input.postalCode !== undefined && { postalCode: input.postalCode }),
          ...(input.countryCode !== undefined && { countryCode: input.countryCode }),
          ...(input.taxNumber !== undefined && { taxNumber: input.taxNumber }),
          ...(input.timezone !== undefined && { timezone: input.timezone }),
          // currencyCode is intentionally NOT updatable: existing invoices are
          // denominated in it, so changing it would silently reinterpret
          // historical financial records. Needs an explicit migration flow.
        },
        include: { settings: true },
      });

      await this.audit.record(tx, {
        organisationId: org.organisationId,
        userId: authContext.user.userId,
        action: 'ORGANISATION_UPDATED',
        entityType: 'organisation',
        entityId: org.organisationId,
        oldValues: { name: before.name, email: before.email, taxNumber: before.taxNumber },
        newValues: { name: updated.name, email: updated.email, taxNumber: updated.taxNumber },
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        requestId: (req as { requestId?: string }).requestId ?? null,
      });

      return updated;
    });
  }

  /** Members of the active organisation. */
  @RequirePermission('user:manage')
  @Get('current/members')
  async members(@CurrentOrganisation() org: OrganisationContext) {
    return withTenant(org.organisationId, (tx) =>
      tx.organisationMember.findMany({
        where: { organisationId: org.organisationId },
        select: {
          id: true,
          role: true,
          isActive: true,
          createdAt: true,
          user: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }
}
