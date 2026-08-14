import { Controller, Get, Post, Patch, Param, Body, Query, Req, Inject } from '@nestjs/common';
import type { Request } from 'express';
import {
  createQuotationSchema,
  updateQuotationSchema,
  quotationListQuerySchema,
  rejectQuotationSchema,
  cancelQuotationSchema,
  convertQuotationSchema,
  uuidSchema,
  type CreateQuotationInput,
  type UpdateQuotationInput,
  type QuotationListQuery,
  type ConvertQuotationInput,
} from '@billing/validation';
import type { OrganisationContext } from '@billing/types';
import { zodPipe } from '../common/pipes/zod-validation.pipe.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { CurrentAuth, CurrentOrganisation } from '../common/decorators/current-context.decorator.js';
import type { AuthContext } from '../common/types/request.js';
import { notFound } from '../common/errors/app-error.js';
import { QuotationsService } from './quotations.service.js';
import type { AuditMeta } from '../customers/customers.service.js';

/**
 * Quotations API (TICKET-014 … TICKET-022).
 *
 * Status is never settable via PATCH. Each lifecycle move is its own POST, so
 * the permitted transitions are explicit in the route table and each can carry
 * its own permission and audit action (Security Doc §18).
 */
@Controller({ path: 'quotations', version: '1' })
export class QuotationsController {
  constructor(@Inject(QuotationsService) private readonly quotations: QuotationsService) {}

  private meta(req: Request, auth: AuthContext): AuditMeta {
    return {
      userId: auth.user.userId,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      requestId: (req as { requestId?: string }).requestId ?? null,
    };
  }

  private parseId(id: string): string {
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) {
      throw notFound('QUOTATION_NOT_FOUND', `Malformed quotation id: ${id.slice(0, 64)}`);
    }
    return parsed.data;
  }

  @RequirePermission('quotation:view')
  @Get()
  list(
    @CurrentOrganisation() org: OrganisationContext,
    @Query(zodPipe(quotationListQuerySchema)) query: QuotationListQuery,
  ) {
    return this.quotations.list(org, query);
  }

  @RequirePermission('quotation:view')
  @Get(':id')
  findOne(@CurrentOrganisation() org: OrganisationContext, @Param('id') id: string) {
    return this.quotations.findOne(org, this.parseId(id));
  }

  @RequirePermission('quotation:write')
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Body(zodPipe(createQuotationSchema)) input: CreateQuotationInput,
    @Req() req: Request,
  ) {
    return this.quotations.create(org, input, this.meta(req, auth));
  }

  @RequirePermission('quotation:write')
  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Body(zodPipe(updateQuotationSchema)) input: UpdateQuotationInput,
    @Req() req: Request,
  ) {
    return this.quotations.update(org, this.parseId(id), input, this.meta(req, auth));
  }

  // --- lifecycle (TICKET-019) ------------------------------------------------

  @RequirePermission('quotation:send')
  @Post(':id/send')
  send(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.quotations.send(org, this.parseId(id), this.meta(req, auth));
  }

  /**
   * Accept / reject record the customer's decision, so they sit under
   * quotation:write rather than a separate permission — whoever manages the
   * quotation records its outcome.
   */
  @RequirePermission('quotation:write')
  @Post(':id/accept')
  accept(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.quotations.accept(org, this.parseId(id), this.meta(req, auth));
  }

  @RequirePermission('quotation:write')
  @Post(':id/reject')
  reject(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Body(zodPipe(rejectQuotationSchema)) input: { reason?: string | null },
    @Req() req: Request,
  ) {
    return this.quotations.reject(org, this.parseId(id), input.reason ?? null, this.meta(req, auth));
  }

  @RequirePermission('quotation:write')
  @Post(':id/cancel')
  cancel(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Body(zodPipe(cancelQuotationSchema)) input: { reason?: string | null },
    @Req() req: Request,
  ) {
    return this.quotations.cancel(org, this.parseId(id), input.reason ?? null, this.meta(req, auth));
  }

  // --- TICKET-021 duplicate --------------------------------------------------

  @RequirePermission('quotation:write')
  @Post(':id/duplicate')
  duplicate(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.quotations.duplicate(org, this.parseId(id), this.meta(req, auth));
  }

  // --- TICKET-022 convert ----------------------------------------------------

  /**
   * Convert to an invoice. Idempotent: a repeat call returns the invoice
   * created by the first, rather than creating a second.
   *
   * Gated on quotation:convert, which SALES only holds when the organisation
   * enables allow_sales_convert_quotation (Security Doc §12).
   */
  @RequirePermission('quotation:convert')
  @Post(':id/convert-to-invoice')
  convert(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Body(zodPipe(convertQuotationSchema)) input: ConvertQuotationInput,
    @Req() req: Request,
  ) {
    return this.quotations.convertToInvoice(org, this.parseId(id), input, this.meta(req, auth));
  }
}
