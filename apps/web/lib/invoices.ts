import { apiFetch } from './api-client';
import type { Paginated, InvoiceStatus } from '@billing/types';
import type { Customer } from './customers';
import type { LineItemDraft } from './quotations';

/** Invoice API bindings (TICKET-023 … TICKET-030). */

export interface InvoiceItem {
  id: string;
  position: number;
  stockItemId: string | null;
  description: string;
  quantity: string;
  unit: string | null;
  unitPrice: string;
  discountRate: string;
  discountAmount: string;
  taxRate: string;
  taxAmount: string;
  lineTotal: string;
}

export interface Invoice {
  id: string;
  organisationId: string;
  customerId: string;
  quotationId: string | null;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  status: InvoiceStatus;
  currencyCode: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  totalAmount: string;
  amountPaid: string;
  amountDue: string;
  notes: string | null;
  terms: string | null;
  createdBy: string;
  sentAt: string | null;
  paidAt: string | null;
  cancelledAt: string | null;
  cancelledReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  customer?: Pick<Customer, 'id' | 'companyName' | 'contactName'>;
}

export interface InvoiceAllocation {
  id: string;
  allocatedAmount: string;
  createdAt: string;
  payment: {
    id: string;
    paymentNumber: string;
    paymentDate: string;
    paymentMethod: string;
    reference: string | null;
    status: string;
  };
}

export interface InvoiceDetail extends Invoice {
  items: InvoiceItem[];
  customer: Customer;
  quotation: { id: string; quotationNumber: string } | null;
  allocations: InvoiceAllocation[];
}

export interface InvoiceListParams {
  page?: number;
  limit?: number;
  search?: string;
  status?: InvoiceStatus;
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
  outstanding?: 'true' | 'false';
  sort?: 'issueDate' | 'dueDate' | 'invoiceNumber' | 'totalAmount' | 'amountDue';
  direction?: 'asc' | 'desc';
}

export function listInvoices(params: InvoiceListParams = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch<Paginated<Invoice>>(`/invoices${suffix}`);
}

export const getInvoice = (id: string) => apiFetch<InvoiceDetail>(`/invoices/${id}`);

export interface InvoiceFormValues {
  customerId: string;
  issueDate: string;
  dueDate: string;
  items: LineItemDraft[];
  discountRate: string;
  notes: string;
  terms: string;
}

function toPayload(values: InvoiceFormValues) {
  return {
    customerId: values.customerId,
    issueDate: values.issueDate,
    dueDate: values.dueDate || null,
    items: values.items.map((item) => ({
      stockItemId: item.stockItemId,
      description: item.description.trim(),
      quantity: item.quantity || '0',
      // Unit is no longer edited per line — it comes from the picked product.
      unit: item.unit.trim() || null,
      unitPrice: item.unitPrice || '0',
      // Per-line discount was removed from the editor. Existing documents keep
      // theirs; new lines are always created without one.
      discountRate: null,
      taxRate: item.taxRate || '0',
    })),
    discount:
      values.discountRate && Number(values.discountRate) > 0 ? { rate: values.discountRate } : null,
    notes: values.notes.trim() || null,
    terms: values.terms.trim() || null,
  };
}

export const createInvoice = (values: InvoiceFormValues) =>
  apiFetch<InvoiceDetail>('/invoices', { method: 'POST', json: toPayload(values) });

export const updateInvoice = (id: string, values: InvoiceFormValues, expectedVersion?: number) =>
  apiFetch<InvoiceDetail>(`/invoices/${id}`, {
    method: 'PATCH',
    json: { ...toPayload(values), expectedVersion },
  });

export const sendInvoice = (id: string) =>
  apiFetch<Invoice>(`/invoices/${id}/send`, { method: 'POST' });

/** Cancellation always requires a reason; it becomes part of the audit trail. */
export const cancelInvoice = (id: string, reason: string) =>
  apiFetch<Invoice>(`/invoices/${id}/cancel`, { method: 'POST', json: { reason } });

export const duplicateInvoice = (id: string) =>
  apiFetch<InvoiceDetail>(`/invoices/${id}/duplicate`, { method: 'POST' });

export const getInvoicePdfUrl = (id: string) =>
  apiFetch<{ url: string; fileName: string; expiresInSeconds: number }>(`/invoices/${id}/pdf`);

export const recalculateOverdue = () =>
  apiFetch<{ updated: number }>('/invoices/recalculate-overdue', { method: 'POST' });

// --- helpers -----------------------------------------------------------------

export const INVOICE_STATUS_TONE: Record<InvoiceStatus, 'gray' | 'blue' | 'green' | 'red' | 'orange'> = {
  DRAFT: 'gray',
  SENT: 'blue',
  PARTIALLY_PAID: 'blue',
  PAID: 'green',
  OVERDUE: 'red',
  CANCELLED: 'gray',
};

/**
 * Which actions to offer for a status.
 *
 * Mirrors the server's transition table and cancellation rules. This decides
 * what to show; the API decides what to allow.
 */
export function invoiceActions(invoice: Pick<Invoice, 'status' | 'amountPaid' | 'amountDue'>) {
  const hasPayments = Number(invoice.amountPaid) > 0;

  return {
    canEdit: invoice.status === 'DRAFT',
    canSend: invoice.status === 'DRAFT',
    canRecordPayment:
      (invoice.status === 'SENT' ||
        invoice.status === 'PARTIALLY_PAID' ||
        invoice.status === 'OVERDUE') &&
      Number(invoice.amountDue) > 0,
    // An invoice holding payments must have them voided first.
    canCancel:
      !hasPayments &&
      invoice.status !== 'PAID' &&
      invoice.status !== 'CANCELLED',
    canDuplicate: true,
  };
}

export function emptyInvoiceForm(defaultTaxRate = '0', paymentTermsDays = 30): InvoiceFormValues {
  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + paymentTermsDays * 86_400_000).toISOString().slice(0, 10);

  return {
    customerId: '',
    issueDate: today,
    dueDate: due,
    items: [
      {
        key: crypto.randomUUID(),
        stockItemId: null,
        description: '',
        quantity: '1',
        unit: '',
        unitPrice: '',
        discountRate: '',
        taxRate: defaultTaxRate,
      },
    ],
    discountRate: '',
    notes: '',
    terms: '',
  };
}

const trimZeros = (value: string) =>
  value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;

export function invoiceToForm(invoice: InvoiceDetail): InvoiceFormValues {
  return {
    customerId: invoice.customerId,
    issueDate: invoice.issueDate.slice(0, 10),
    dueDate: invoice.dueDate.slice(0, 10),
    items: invoice.items.map((item) => ({
      key: item.id,
      stockItemId: item.stockItemId ?? null,
      description: item.description,
      quantity: trimZeros(item.quantity),
      unit: item.unit ?? '',
      unitPrice: trimZeros(item.unitPrice),
      discountRate: Number(item.discountRate) > 0 ? trimZeros(item.discountRate) : '',
      taxRate: trimZeros(item.taxRate),
    })),
    // Document-level discount is stored as an amount; the form edits a rate.
    // Editing is DRAFT-only and the Phase 2 UI offers rate-based discounts.
    discountRate: '',
    notes: invoice.notes ?? '',
    terms: invoice.terms ?? '',
  };
}
