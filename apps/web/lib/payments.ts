import { apiFetch } from './api-client';
import type { Paginated } from '@billing/types';
import type { Customer } from './customers';

/** Payment API bindings (TICKET-031 … TICKET-034). */

export const PAYMENT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'CARD',
  'CHEQUE',
  'UPI',
  'OTHER',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Labels for display. Acronyms stay upper-case: "UPI", never "Upi". */
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  CARD: 'Card',
  CHEQUE: 'Cheque',
  UPI: 'UPI',
  OTHER: 'Other',
};

export const paymentMethodLabel = (method: string) =>
  PAYMENT_METHOD_LABELS[method as PaymentMethod] ?? method;

export interface Payment {
  id: string;
  organisationId: string;
  customerId: string;
  paymentNumber: string;
  paymentDate: string;
  amount: string;
  currencyCode: string;
  paymentMethod: PaymentMethod;
  reference: string | null;
  notes: string | null;
  status: 'RECORDED' | 'VOIDED';
  idempotencyKey: string | null;
  voidedAt: string | null;
  voidedReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  customer?: Pick<Customer, 'id' | 'companyName' | 'contactName'>;
  allocations?: Array<{
    allocatedAmount: string;
    invoice: { id: string; invoiceNumber: string };
  }>;
}

export interface PaymentDetail extends Payment {
  customer: Customer;
  allocations: Array<{
    id: string;
    allocatedAmount: string;
    createdAt: string;
    invoice: {
      id: string;
      invoiceNumber: string;
      status: string;
      totalAmount: string;
      amountDue: string;
    };
  }>;
}

export interface PaymentListParams {
  page?: number;
  limit?: number;
  search?: string;
  customerId?: string;
  invoiceId?: string;
  status?: 'RECORDED' | 'VOIDED';
  method?: PaymentMethod;
  dateFrom?: string;
  dateTo?: string;
  sort?: 'paymentDate' | 'amount' | 'paymentNumber';
  direction?: 'asc' | 'desc';
}

export function listPayments(params: PaymentListParams = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch<Paginated<Payment>>(`/payments${suffix}`);
}

export const getPayment = (id: string) => apiFetch<PaymentDetail>(`/payments/${id}`);

export interface RecordPaymentValues {
  amount: string;
  paymentDate: string;
  paymentMethod: PaymentMethod;
  reference: string;
  notes: string;
}

export interface RecordPaymentResult {
  payment: Payment;
  invoice: { id: string; invoiceNumber: string; status: string; amountDue: string } | null;
  replayed: boolean;
}

/**
 * Record a payment against an invoice.
 *
 * The idempotency key is generated once per form session by the caller and
 * reused across retries, so a double-click or a network retry resolves to the
 * payment already recorded rather than taking the money twice.
 */
export const recordPayment = (
  invoiceId: string,
  values: RecordPaymentValues,
  idempotencyKey: string,
) =>
  apiFetch<RecordPaymentResult>(`/invoices/${invoiceId}/payments`, {
    method: 'POST',
    json: {
      amount: values.amount,
      paymentDate: values.paymentDate,
      paymentMethod: values.paymentMethod,
      reference: values.reference.trim() || null,
      notes: values.notes.trim() || null,
      idempotencyKey,
    },
  });

export const voidPayment = (id: string, reason: string) =>
  apiFetch<{ payment: Payment; invoices: unknown[] }>(`/payments/${id}/void`, {
    method: 'POST',
    json: { reason },
  });

/** Today in UTC as YYYY-MM-DD — the API rejects future-dated payments. */
export const todayIso = () => new Date().toISOString().slice(0, 10);
