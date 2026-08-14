import { Injectable, Inject } from '@nestjs/common';
import { withTenant, nextDocumentNumber, Prisma, type TenantClient } from '@billing/database';
import { calculateBalance, type RecordPaymentInput, type PaymentListQuery } from '@billing/validation';
import {
  checkScopedPermission,
  type OrganisationContext,
  type Paginated,
  type InvoiceStatus,
} from '@billing/types';
import { AuditService } from '../common/audit/audit.service.js';
import { notFound, conflict, validationFailed, forbidden } from '../common/errors/app-error.js';
import type { AuditMeta } from '../customers/customers.service.js';

/**
 * Payment domain logic (TICKET-031 … TICKET-034).
 *
 * This is the first code that mutates money on an already-issued document, so
 * every operation follows the ADR-009 pattern: lock the contended row, re-read
 * inside the lock, then act.
 *
 * Guarantees:
 *   - Idempotent. A retry with the same key returns the original payment.
 *   - Balances are stored, never derived on read, and only ever updated inside
 *     the transaction that changes them.
 *   - Overpayment is rejected (Security Doc §30).
 *   - Voiding reverses the allocation; no payment row is ever deleted.
 */

const PAYMENT_SELECT = {
  id: true,
  organisationId: true,
  customerId: true,
  paymentNumber: true,
  paymentDate: true,
  amount: true,
  currencyCode: true,
  paymentMethod: true,
  reference: true,
  notes: true,
  status: true,
  idempotencyKey: true,
  voidedAt: true,
  voidedReason: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PaymentSelect;

/** Statuses that can receive a payment. */
const PAYABLE_STATUSES: InvoiceStatus[] = ['SENT', 'PARTIALLY_PAID', 'OVERDUE'];

@Injectable()
export class PaymentsService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  // -------------------------------------------------------------------------
  // TICKET-033 — list
  // -------------------------------------------------------------------------

  async list(org: OrganisationContext, query: PaymentListQuery): Promise<Paginated<unknown>> {
    return withTenant(org.organisationId, async (tx) => {
      const where: Prisma.PaymentWhereInput = { organisationId: org.organisationId };

      if (query.status) where.status = query.status;
      if (query.customerId) where.customerId = query.customerId;
      if (query.method) where.paymentMethod = query.method;
      if (query.invoiceId) where.allocations = { some: { invoiceId: query.invoiceId } };

      if (query.dateFrom || query.dateTo) {
        where.paymentDate = {
          ...(query.dateFrom && { gte: new Date(`${query.dateFrom}T00:00:00.000Z`) }),
          ...(query.dateTo && { lte: new Date(`${query.dateTo}T00:00:00.000Z`) }),
        };
      }

      if (query.search) {
        const contains = { contains: query.search, mode: 'insensitive' as const };
        where.OR = [
          { paymentNumber: contains },
          { reference: contains },
          { customer: { companyName: contains } },
          { customer: { contactName: contains } },
        ];
      }

      const orderBy: Prisma.PaymentOrderByWithRelationInput =
        query.sort === 'amount'
          ? { amount: query.direction }
          : query.sort === 'paymentNumber'
            ? { paymentNumber: query.direction }
            : { paymentDate: query.direction };

      const [items, total] = await Promise.all([
        tx.payment.findMany({
          where,
          select: {
            ...PAYMENT_SELECT,
            customer: { select: { id: true, companyName: true, contactName: true } },
            allocations: {
              select: {
                allocatedAmount: true,
                invoice: { select: { id: true, invoiceNumber: true } },
              },
            },
          },
          orderBy,
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        tx.payment.count({ where }),
      ]);

      return {
        items,
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      };
    });
  }

  async findOne(org: OrganisationContext, paymentId: string) {
    const payment = await withTenant(org.organisationId, (tx) =>
      tx.payment.findFirst({
        where: { id: paymentId, organisationId: org.organisationId },
        select: {
          ...PAYMENT_SELECT,
          customer: true,
          allocations: {
            select: {
              id: true,
              allocatedAmount: true,
              createdAt: true,
              invoice: {
                select: {
                  id: true,
                  invoiceNumber: true,
                  status: true,
                  totalAmount: true,
                  amountDue: true,
                },
              },
            },
          },
        },
      }),
    );

    if (!payment) throw notFound('PAYMENT_NOT_FOUND', `Payment ${paymentId} not in org`);
    return payment;
  }

  // -------------------------------------------------------------------------
  // TICKET-031 / TICKET-032 / TICKET-034 — record a payment
  // -------------------------------------------------------------------------

  /**
   * Record a payment against one invoice.
   *
   * Ordering inside the transaction is load-bearing:
   *
   *   1. Check the idempotency key first, before any lock or write. A replay
   *      must be cheap and must not touch the invoice at all.
   *   2. Lock the invoice row FOR UPDATE. Two concurrent payments against the
   *      same invoice serialise here; without this both would read the same
   *      stale balance and could jointly overpay.
   *   3. Re-read the balance inside the lock — the value read before waiting
   *      is exactly the one that may now be wrong.
   *   4. Validate against the freshly-read balance, then write payment,
   *      allocation and new invoice balance atomically.
   *
   * Per ADR-009 this ships with a concurrent test, not only a sequential one.
   */
  async record(
    org: OrganisationContext,
    invoiceId: string,
    input: RecordPaymentInput,
    meta: AuditMeta,
  ) {
    return withTenant(
      org.organisationId,
      async (tx) => {
        // --- 1. Idempotency replay -----------------------------------------
        const replay = await tx.payment.findFirst({
          where: { organisationId: org.organisationId, idempotencyKey: input.idempotencyKey },
          select: {
            ...PAYMENT_SELECT,
            allocations: {
              select: {
                allocatedAmount: true,
                invoice: { select: { id: true, invoiceNumber: true, status: true, amountDue: true } },
              },
            },
          },
        });

        if (replay) {
          // Same key, different invoice means a genuine client bug — surface
          // it rather than silently returning an unrelated payment.
          const target = replay.allocations[0]?.invoice;
          if (target && target.id !== invoiceId) {
            throw conflict(
              'IDEMPOTENCY_KEY_REUSED',
              `Key already used for invoice ${target.invoiceNumber}`,
            );
          }
          return { payment: replay, invoice: target ?? null, replayed: true as const };
        }

        // --- 2. Lock the invoice --------------------------------------------
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM invoices
           WHERE id = ${invoiceId}::uuid
             AND organisation_id = ${org.organisationId}::uuid
           FOR UPDATE
        `;
        if (locked.length === 0) {
          throw notFound('INVOICE_NOT_FOUND', `Invoice ${invoiceId} not in org`);
        }

        // --- 3. Re-read inside the lock --------------------------------------
        const invoice = await tx.invoice.findUniqueOrThrow({
          where: { id: invoiceId },
          select: {
            id: true,
            invoiceNumber: true,
            customerId: true,
            status: true,
            currencyCode: true,
            totalAmount: true,
            amountPaid: true,
            amountDue: true,
          },
        });

        const status = invoice.status as InvoiceStatus;
        if (!PAYABLE_STATUSES.includes(status)) {
          throw conflict(
            'INVALID_STATUS_TRANSITION',
            status === 'DRAFT'
              ? 'Send the invoice before recording a payment against it'
              : `Cannot record a payment against a ${status} invoice`,
          );
        }

        // --- 4. Validate against the fresh balance ---------------------------
        const amount = new Prisma.Decimal(input.amount);

        // Overpayment is rejected outright (Security Doc §30). Partial and
        // exact payments are both fine.
        if (amount.greaterThan(invoice.amountDue)) {
          throw validationFailed([
            {
              field: 'amount',
              message: `Payment exceeds the outstanding balance of ${invoice.amountDue.toFixed(2)}`,
            },
          ]);
        }

        const number = await nextDocumentNumber(tx, org.organisationId, 'PAYMENT');

        const payment = await tx.payment.create({
          data: {
            organisationId: org.organisationId,
            customerId: invoice.customerId,
            paymentNumber: number.formatted,
            paymentDate: new Date(`${input.paymentDate}T00:00:00.000Z`),
            amount: input.amount,
            currencyCode: invoice.currencyCode,
            paymentMethod: input.paymentMethod,
            reference: input.reference ?? null,
            notes: input.notes ?? null,
            status: 'RECORDED',
            idempotencyKey: input.idempotencyKey,
            createdBy: meta.userId,
          },
          select: PAYMENT_SELECT,
        });

        await tx.paymentAllocation.create({
          data: { paymentId: payment.id, invoiceId: invoice.id, allocatedAmount: input.amount },
        });

        // --- 5. Recompute and store the balance ------------------------------
        const updated = await this.applyBalance(tx, invoice.id);

        await this.audit.record(tx, {
          organisationId: org.organisationId,
          userId: meta.userId,
          action: 'PAYMENT_RECORDED',
          entityType: 'payment',
          entityId: payment.id,
          newValues: {
            paymentNumber: payment.paymentNumber,
            invoiceNumber: invoice.invoiceNumber,
            amount: input.amount,
            method: input.paymentMethod,
            invoiceStatusAfter: updated.status,
            invoiceBalanceAfter: updated.amountDue.toFixed(4),
          },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });

        return {
          payment,
          invoice: {
            id: updated.id,
            invoiceNumber: updated.invoiceNumber,
            status: updated.status,
            amountDue: updated.amountDue,
          },
          replayed: false as const,
        };
      },
      undefined,
      { userId: meta.userId },
    );
  }

  // -------------------------------------------------------------------------
  // Void a payment
  // -------------------------------------------------------------------------

  /**
   * Void a payment and reverse its allocations.
   *
   * The payment row is never deleted (Security Doc §41 rule 6) — it is marked
   * VOIDED with a reason, and the invoices it touched have their balances
   * recomputed from the remaining RECORDED allocations.
   *
   * Locking order matters and is deliberate: the payment first, then each
   * affected invoice. A void racing a new payment on the same invoice
   * serialises on the invoice lock, so whichever runs second sees the other's
   * committed balance. Two simultaneous voids serialise on the payment lock,
   * and the second finds status VOIDED and stops — the allocation cannot be
   * reversed twice.
   */
  async void(org: OrganisationContext, paymentId: string, reason: string, meta: AuditMeta) {
    return withTenant(
      org.organisationId,
      async (tx) => {
        // Lock the payment before reading its status.
        const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
          SELECT id, status FROM payments
           WHERE id = ${paymentId}::uuid
             AND organisation_id = ${org.organisationId}::uuid
           FOR UPDATE
        `;
        if (locked.length === 0) {
          throw notFound('PAYMENT_NOT_FOUND', `Payment ${paymentId} not in org`);
        }

        // Re-read inside the lock: a concurrent void may have won the race.
        if (locked[0]!.status === 'VOIDED') {
          throw conflict('INVALID_STATUS_TRANSITION', 'This payment has already been voided');
        }

        const payment = await tx.payment.findUniqueOrThrow({
          where: { id: paymentId },
          select: {
            ...PAYMENT_SELECT,
            allocations: { select: { id: true, invoiceId: true, allocatedAmount: true } },
          },
        });

        // Role check against the loaded record: BILLING may void only its own
        // payments (Security Doc §12).
        const scoped = checkScopedPermission(org.role, {
          permission: 'payment:void',
          paymentCreatedBy: payment.createdBy,
          actingUserId: meta.userId,
        });
        if (!scoped.allowed) {
          throw forbidden(scoped.reason ?? 'Voiding not permitted for this payment');
        }

        const affectedInvoiceIds = payment.allocations.map((a) => a.invoiceId);

        // Lock every affected invoice before touching balances, in a stable
        // order so two voids can never deadlock against each other.
        for (const invoiceId of [...affectedInvoiceIds].sort()) {
          await tx.$queryRaw`
            SELECT id FROM invoices
             WHERE id = ${invoiceId}::uuid
               AND organisation_id = ${org.organisationId}::uuid
             FOR UPDATE
          `;
        }

        const voided = await tx.payment.update({
          where: { id: paymentId },
          data: { status: 'VOIDED', voidedAt: new Date(), voidedReason: reason },
          select: PAYMENT_SELECT,
        });

        // Recompute each invoice from its remaining RECORDED allocations
        // rather than subtracting — subtraction compounds any earlier drift.
        const invoices = [];
        for (const invoiceId of affectedInvoiceIds) {
          invoices.push(await this.applyBalance(tx, invoiceId));
        }

        await this.audit.record(tx, {
          organisationId: org.organisationId,
          userId: meta.userId,
          action: 'PAYMENT_VOIDED',
          entityType: 'payment',
          entityId: paymentId,
          oldValues: { status: 'RECORDED', amount: payment.amount.toFixed(4) },
          newValues: {
            status: 'VOIDED',
            reason,
            invoicesRecalculated: invoices.map((i) => ({
              invoiceNumber: i.invoiceNumber,
              status: i.status,
              amountDue: i.amountDue.toFixed(4),
            })),
          },
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });

        return { payment: voided, invoices };
      },
      undefined,
      { userId: meta.userId },
    );
  }

  // -------------------------------------------------------------------------
  // Balance maintenance (TICKET-034)
  // -------------------------------------------------------------------------

  /**
   * Recompute and store an invoice's balance from its RECORDED allocations.
   *
   * The single definition of amountPaid / amountDue / status for an invoice.
   * Always call inside a transaction that already holds the invoice lock.
   *
   * Recomputed from the allocation rows rather than adjusted incrementally:
   * an increment is only correct if every prior write was, whereas a
   * recomputation is self-correcting.
   */
  private async applyBalance(tx: TenantClient, invoiceId: string) {
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: { id: true, invoiceNumber: true, status: true, totalAmount: true, dueDate: true },
    });

    const allocations = await tx.paymentAllocation.findMany({
      where: { invoiceId, payment: { status: 'RECORDED' } },
      select: { allocatedAmount: true },
    });

    const balance = calculateBalance(
      invoice.totalAmount.toFixed(4),
      allocations.map((a) => a.allocatedAmount.toFixed(4)),
    );

    // Status follows the balance. A cancelled invoice is left alone — its
    // status is a business decision, not a function of payments.
    let status = invoice.status as InvoiceStatus;
    if (status !== 'CANCELLED' && status !== 'DRAFT') {
      if (balance.isFullyPaid) {
        status = 'PAID';
      } else if (Number(balance.amountPaid) > 0) {
        status = 'PARTIALLY_PAID';
      } else {
        // Back to unpaid. Overdue if the due date has passed, else SENT.
        const today = new Date();
        const todayUtc = new Date(
          Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
        );
        status = invoice.dueDate < todayUtc ? 'OVERDUE' : 'SENT';
      }

      // A partially-paid invoice past its due date is still overdue.
      if (status === 'PARTIALLY_PAID') {
        const today = new Date();
        const todayUtc = new Date(
          Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
        );
        if (invoice.dueDate < todayUtc) status = 'OVERDUE';
      }
    }

    return tx.invoice.update({
      where: { id: invoiceId },
      data: {
        amountPaid: balance.amountPaid,
        amountDue: balance.amountDue,
        status,
        paidAt: balance.isFullyPaid ? new Date() : null,
        version: { increment: 1 },
      },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        totalAmount: true,
        amountPaid: true,
        amountDue: true,
      },
    });
  }
}
