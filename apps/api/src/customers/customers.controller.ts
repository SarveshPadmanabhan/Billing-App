import { Controller, Get, Post, Patch, Param, Body, Query, Req, Inject } from '@nestjs/common';
import type { Request } from 'express';
import {
  createCustomerSchema,
  updateCustomerSchema,
  customerListQuerySchema,
  archiveCustomerSchema,
  uuidSchema,
  type CreateCustomerInput,
  type UpdateCustomerInput,
  type CustomerListQuery,
  type ArchiveCustomerInput,
} from '@billing/validation';
import type { OrganisationContext } from '@billing/types';
import { zodPipe } from '../common/pipes/zod-validation.pipe.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { CurrentAuth, CurrentOrganisation } from '../common/decorators/current-context.decorator.js';
import type { AuthContext } from '../common/types/request.js';
import { notFound } from '../common/errors/app-error.js';
import { CustomersService, type AuditMeta } from './customers.service.js';

/**
 * Customers API (TICKET-009 to TICKET-013).
 *
 * There is deliberately no DELETE endpoint. Customers are archived
 * (Security Doc §41 rule 6) — deleting one would orphan its invoices and
 * destroy financial history.
 */
@Controller({ path: 'customers', version: '1' })
export class CustomersController {
  constructor(@Inject(CustomersService) private readonly customers: CustomersService) {}

  private meta(req: Request, auth: AuthContext): AuditMeta {
    return {
      userId: auth.user.userId,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      requestId: (req as { requestId?: string }).requestId ?? null,
    };
  }

  /** Validate a path id before it reaches the database. */
  private parseId(id: string): string {
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) {
      // A malformed id yields the same 404 as a missing one, so the endpoint
      // reveals nothing about id validity or existence.
      throw notFound('CUSTOMER_NOT_FOUND', `Malformed customer id: ${id.slice(0, 64)}`);
    }
    return parsed.data;
  }

  @RequirePermission('customer:view')
  @Get()
  async list(
    @CurrentOrganisation() org: OrganisationContext,
    @Query(zodPipe(customerListQuerySchema)) query: CustomerListQuery,
  ) {
    return this.customers.list(org, query);
  }

  @RequirePermission('customer:view')
  @Get(':id')
  async findOne(@CurrentOrganisation() org: OrganisationContext, @Param('id') id: string) {
    return this.customers.findOne(org, this.parseId(id));
  }

  /** TICKET-013 — customer detail with quotations, invoices, payments, totals. */
  @RequirePermission('customer:view')
  @Get(':id/billing-history')
  async billingHistory(@CurrentOrganisation() org: OrganisationContext, @Param('id') id: string) {
    return this.customers.billingHistory(org, this.parseId(id));
  }

  @RequirePermission('customer:write')
  @Post()
  async create(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Body(zodPipe(createCustomerSchema)) input: CreateCustomerInput,
    @Req() req: Request,
  ) {
    return this.customers.create(org, input, this.meta(req, auth));
  }

  @RequirePermission('customer:write')
  @Patch(':id')
  async update(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Body(zodPipe(updateCustomerSchema)) input: UpdateCustomerInput,
    @Req() req: Request,
  ) {
    return this.customers.update(org, this.parseId(id), input, this.meta(req, auth));
  }

  /**
   * TICKET-011 — archive.
   *
   * Requires `customer:archive`, a stricter permission than `customer:write`:
   * SALES may create and edit customers but not archive them (Security §12).
   */
  @RequirePermission('customer:archive')
  @Post(':id/archive')
  async archive(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Body(zodPipe(archiveCustomerSchema)) input: ArchiveCustomerInput,
    @Req() req: Request,
  ) {
    return this.customers.archive(org, this.parseId(id), input.reason ?? null, this.meta(req, auth));
  }

  @RequirePermission('customer:archive')
  @Post(':id/restore')
  async restore(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.customers.restore(org, this.parseId(id), this.meta(req, auth));
  }
}
