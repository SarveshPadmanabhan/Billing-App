import { Controller, Get, Post, Patch, Body, Param, Req, Inject } from '@nestjs/common';
import type { Request } from 'express';
import { withTenant, createDocumentSequences } from '@billing/database';
import {
  createCompanySchema,
  updateCompanySchema,
  switchCompanySchema,
  type CreateCompanyInput,
  type UpdateCompanyInput,
  type SwitchCompanyInput,
} from '@billing/validation';
import type { OrganisationContext } from '@billing/types';
import { zodPipe } from '../common/pipes/zod-validation.pipe.js';
import { CurrentAuth, CurrentOrganisation } from '../common/decorators/current-context.decorator.js';
import type { AuthContext } from '../common/types/request.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { notFound, conflict } from '../common/errors/app-error.js';
import { AuditService } from '../common/audit/audit.service.js';
import { prisma } from '@billing/database';

/**
 * Companies within an organisation.
 *
 * The organisation is still the tenant boundary — every query here runs inside
 * withTenant and RLS keys on organisation_id. A company scopes *what a user is
 * looking at*, not what they are allowed to reach: any member can switch to
 * any company in their organisation. Anything needing real isolation belongs
 * in a separate organisation.
 */
@Controller({ path: 'companies', version: '1' })
export class CompaniesController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @RequirePermission('dashboard:view')
  @Get()
  async list(@CurrentOrganisation() org: OrganisationContext) {
    return withTenant(org.organisationId, (tx) =>
      tx.company.findMany({
        where: { organisationId: org.organisationId, isArchived: false },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          legalName: true,
          email: true,
          phone: true,
          city: true,
          state: true,
          countryCode: true,
          currencyCode: true,
          taxNumber: true,
          invoicePrefix: true,
          quotationPrefix: true,
          isDefault: true,
          createdAt: true,
        },
      }),
    );
  }

  @RequirePermission('organisation:settings')
  @Post()
  async create(
    @CurrentAuth() authContext: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Body(zodPipe(createCompanySchema)) input: CreateCompanyInput,
    @Req() req: Request,
  ) {
    return withTenant(org.organisationId, async (tx) => {
      const duplicate = await tx.company.findFirst({
        where: { organisationId: org.organisationId, name: input.name, isArchived: false },
        select: { id: true },
      });
      if (duplicate) {
        throw conflict('COMPANY_NAME_TAKEN', `A company named "${input.name}" already exists`);
      }

      const company = await tx.company.create({
        data: {
          // Tenant from the verified session, never the payload.
          organisationId: org.organisationId,
          name: input.name,
          legalName: input.legalName ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          postalCode: input.postalCode ?? null,
          countryCode: input.countryCode,
          taxNumber: input.taxNumber ?? null,
          currencyCode: input.currencyCode,
          invoicePrefix: input.invoicePrefix,
          quotationPrefix: input.quotationPrefix,
          paymentPrefix: input.paymentPrefix,
          // Never the default: an organisation has exactly one, set at
          // creation and changed only through the explicit endpoint. A partial
          // unique index enforces this at the database too.
          isDefault: false,
        },
      });

      // In the same transaction as the company. A company without sequences
      // cannot issue anything, and the first invoice would fail with a null
      // constraint violation long after the company appeared to be created.
      await createDocumentSequences(tx, org.organisationId, company.id, {
        invoicePrefix: input.invoicePrefix,
        quotationPrefix: input.quotationPrefix,
        paymentPrefix: input.paymentPrefix,
        invoiceStartNumber: 1n,
        quotationStartNumber: 1n,
        padding: 6,
      });

      await this.audit.record(tx, {
        organisationId: org.organisationId,
        userId: authContext.user.userId,
        action: 'COMPANY_CREATED',
        entityType: 'company',
        entityId: company.id,
        newValues: { name: company.name, invoicePrefix: company.invoicePrefix },
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        requestId: (req as { requestId?: string }).requestId ?? null,
      });

      return company;
    });
  }

  @RequirePermission('organisation:settings')
  @Patch(':id')
  async update(
    @CurrentAuth() authContext: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Body(zodPipe(updateCompanySchema)) input: UpdateCompanyInput,
    @Req() req: Request,
  ) {
    return withTenant(org.organisationId, async (tx) => {
      const before = await tx.company.findFirst({
        where: { id, organisationId: org.organisationId },
      });
      // 404 rather than 403 for a company outside this organisation: a 403
      // would confirm the id exists and make the endpoint an enumeration
      // oracle (Security Doc §16).
      if (!before) {
        throw notFound('COMPANY_NOT_FOUND', `Company ${id} not found`);
      }

      const updated = await tx.company.update({
        where: { id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.legalName !== undefined && { legalName: input.legalName }),
          ...(input.email !== undefined && { email: input.email }),
          ...(input.phone !== undefined && { phone: input.phone }),
          ...(input.addressLine1 !== undefined && { addressLine1: input.addressLine1 }),
          ...(input.addressLine2 !== undefined && { addressLine2: input.addressLine2 }),
          ...(input.city !== undefined && { city: input.city }),
          ...(input.state !== undefined && { state: input.state }),
          ...(input.postalCode !== undefined && { postalCode: input.postalCode }),
          ...(input.countryCode !== undefined && { countryCode: input.countryCode }),
          ...(input.taxNumber !== undefined && { taxNumber: input.taxNumber }),
        },
      });

      await this.audit.record(tx, {
        organisationId: org.organisationId,
        userId: authContext.user.userId,
        action: 'COMPANY_UPDATED',
        entityType: 'company',
        entityId: id,
        oldValues: { name: before.name },
        newValues: { name: updated.name },
        ipAddress: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        requestId: (req as { requestId?: string }).requestId ?? null,
      });

      return updated;
    });
  }

  /**
   * Select the active company for this session.
   *
   * Mirrors switch-organisation: membership of the organisation is already
   * proven by the guard, and the company is confirmed to belong to that
   * organisation before the session is written. This is the ONLY way
   * session.activeCompanyId is ever set — the field is `input: false` in the
   * auth config, so a client cannot set it directly.
   */
  @RequirePermission('dashboard:view')
  @Post('switch')
  async switch(
    @CurrentAuth() authContext: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Body(zodPipe(switchCompanySchema)) input: SwitchCompanyInput,
  ) {
    const company = await withTenant(org.organisationId, (tx) =>
      tx.company.findFirst({
        where: { id: input.companyId, organisationId: org.organisationId, isArchived: false },
        select: { id: true, name: true },
      }),
    );

    if (!company) {
      throw notFound('COMPANY_NOT_FOUND', `Company ${input.companyId} not found`);
    }

    // sessions is keyed by user, not organisation, and carries no RLS policy,
    // so this write is deliberately outside withTenant.
    await prisma.session.update({
      where: { id: authContext.sessionId },
      data: { activeCompanyId: company.id },
    });

    return { companyId: company.id, companyName: company.name };
  }
}
