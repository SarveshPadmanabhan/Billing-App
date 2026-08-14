import { Controller, Get, Post, Patch, Param, Body, Query, Req, Inject } from '@nestjs/common';
import type { Request } from 'express';
import {
  createInvoiceSchema,
  updateInvoiceSchema,
  invoiceListQuerySchema,
  cancelInvoiceSchema,
  uuidSchema,
  type CreateInvoiceInput,
  type UpdateInvoiceInput,
  type InvoiceListQuery,
  type CancelInvoiceInput,
} from '@billing/validation';
import type { OrganisationContext } from '@billing/types';
import { zodPipe } from '../common/pipes/zod-validation.pipe.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { CurrentAuth, CurrentOrganisation } from '../common/decorators/current-context.decorator.js';
import type { AuthContext } from '../common/types/request.js';
import { notFound } from '../common/errors/app-error.js';
import { InvoicesService } from './invoices.service.js';
import { PdfService } from '../documents/pdf.service.js';
import type { AuditMeta } from '../customers/customers.service.js';

/**
 * Invoices API (TICKET-023 … TICKET-030).
 *
 * There is no DELETE route. An issued invoice is cancelled, never removed, so
 * the numbering sequence and financial history stay intact.
 */
@Controller({ path: 'invoices', version: '1' })
export class InvoicesController {
  constructor(
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(PdfService) private readonly pdf: PdfService,
  ) {}

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
      throw notFound('INVOICE_NOT_FOUND', `Malformed invoice id: ${id.slice(0, 64)}`);
    }
    return parsed.data;
  }

  @RequirePermission('invoice:view')
  @Get()
  list(
    @CurrentOrganisation() org: OrganisationContext,
    @Query(zodPipe(invoiceListQuerySchema)) query: InvoiceListQuery,
  ) {
    return this.invoices.list(org, query);
  }

  /**
   * TICKET-035 — recompute overdue status.
   *
   * Declared BEFORE the ':id' routes: Express matches in registration order,
   * so a later static path would be captured by ':id' and rejected as a
   * malformed UUID. Idempotent, so a scheduler can call it freely.
   */
  @RequirePermission('invoice:write')
  @Post('recalculate-overdue')
  async recalculateOverdue(@CurrentOrganisation() org: OrganisationContext) {
    const updated = await this.invoices.markOverdue(org);
    return { updated };
  }

  @RequirePermission('invoice:view')
  @Get(':id')
  findOne(@CurrentOrganisation() org: OrganisationContext, @Param('id') id: string) {
    return this.invoices.findOne(org, this.parseId(id));
  }

  @RequirePermission('invoice:write')
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Body(zodPipe(createInvoiceSchema)) input: CreateInvoiceInput,
    @Req() req: Request,
  ) {
    return this.invoices.create(org, input, this.meta(req, auth));
  }

  @RequirePermission('invoice:write')
  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Body(zodPipe(updateInvoiceSchema)) input: UpdateInvoiceInput,
    @Req() req: Request,
  ) {
    return this.invoices.update(org, this.parseId(id), input, this.meta(req, auth));
  }

  @RequirePermission('invoice:send')
  @Post(':id/send')
  send(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.invoices.send(org, this.parseId(id), this.meta(req, auth));
  }

  /**
   * Cancel (TICKET-028).
   *
   * `@RequirePermission` is the coarse gate; the service applies
   * `checkScopedPermission` against the loaded record, because BILLING's grant
   * depends on the invoice's status.
   */
  @RequirePermission('invoice:cancel')
  @Post(':id/cancel')
  cancel(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Body(zodPipe(cancelInvoiceSchema)) input: CancelInvoiceInput,
    @Req() req: Request,
  ) {
    return this.invoices.cancel(org, this.parseId(id), input.reason, this.meta(req, auth));
  }

  @RequirePermission('invoice:write')
  @Post(':id/duplicate')
  duplicate(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.invoices.duplicate(org, this.parseId(id), this.meta(req, auth));
  }

  /** TICKET-029 — invoice PDF as a short-lived signed URL. */
  @RequirePermission('invoice:view')
  @Get(':id/pdf')
  pdfUrl(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
  ) {
    return this.pdf.downloadUrl(org, 'invoices', this.parseId(id), auth.user.userId);
  }

}
