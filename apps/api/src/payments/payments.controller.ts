import { Controller, Get, Post, Param, Body, Query, Req, Inject } from '@nestjs/common';
import type { Request } from 'express';
import {
  recordPaymentSchema,
  voidPaymentSchema,
  paymentListQuerySchema,
  uuidSchema,
  type RecordPaymentInput,
  type VoidPaymentInput,
  type PaymentListQuery,
} from '@billing/validation';
import type { OrganisationContext } from '@billing/types';
import { zodPipe } from '../common/pipes/zod-validation.pipe.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { CurrentAuth, CurrentOrganisation } from '../common/decorators/current-context.decorator.js';
import type { AuthContext } from '../common/types/request.js';
import { notFound } from '../common/errors/app-error.js';
import { PaymentsService } from './payments.service.js';
import type { AuditMeta } from '../customers/customers.service.js';

/**
 * Payments API (TICKET-031 … TICKET-034).
 *
 * Recording lives under /invoices/:id/payments because a payment is always
 * against an invoice (Frontend Spec §21). Listing and voiding live under
 * /payments, where the payment is the subject.
 *
 * There is no DELETE route: payments are voided, never removed.
 */
@Controller({ version: '1' })
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  private meta(req: Request, auth: AuthContext): AuditMeta {
    return {
      userId: auth.user.userId,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      requestId: (req as { requestId?: string }).requestId ?? null,
    };
  }

  private parseId(id: string, kind: 'invoice' | 'payment'): string {
    const parsed = uuidSchema.safeParse(id);
    if (!parsed.success) {
      throw notFound(
        kind === 'invoice' ? 'INVOICE_NOT_FOUND' : 'PAYMENT_NOT_FOUND',
        `Malformed ${kind} id: ${id.slice(0, 64)}`,
      );
    }
    return parsed.data;
  }

  @RequirePermission('payment:view')
  @Get('payments')
  list(
    @CurrentOrganisation() org: OrganisationContext,
    @Query(zodPipe(paymentListQuerySchema)) query: PaymentListQuery,
  ) {
    return this.payments.list(org, query);
  }

  @RequirePermission('payment:view')
  @Get('payments/:id')
  findOne(@CurrentOrganisation() org: OrganisationContext, @Param('id') id: string) {
    return this.payments.findOne(org, this.parseId(id, 'payment'));
  }

  /**
   * Record a payment against an invoice.
   *
   * Requires an idempotency key in the body, so a double-click or network
   * retry resolves to the payment already recorded (Security Doc §19).
   */
  @RequirePermission('payment:record')
  @Post('invoices/:id/payments')
  record(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Body(zodPipe(recordPaymentSchema)) input: RecordPaymentInput,
    @Req() req: Request,
  ) {
    return this.payments.record(org, this.parseId(id, 'invoice'), input, this.meta(req, auth));
  }

  /**
   * Void a payment.
   *
   * `@RequirePermission` is the coarse gate; the service applies
   * `checkScopedPermission` against the loaded record, because BILLING may
   * void only the payments it recorded.
   */
  @RequirePermission('payment:void')
  @Post('payments/:id/void')
  voidPayment(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Body(zodPipe(voidPaymentSchema)) input: VoidPaymentInput,
    @Req() req: Request,
  ) {
    return this.payments.void(org, this.parseId(id, 'payment'), input.reason, this.meta(req, auth));
  }
}
