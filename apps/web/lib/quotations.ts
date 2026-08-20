import { apiFetch } from './api-client';
import type { Paginated, QuotationStatus } from '@billing/types';
import type { Customer } from './customers';

/** Quotation API bindings (TICKET-014 … TICKET-022). */

export interface QuotationItem {
  id: string;
  position: number;
  description: string;
  quantity: string;
  stockItemId: string | null;
  unit: string | null;
  unitPrice: string;
  discountRate: string;
  discountAmount: string;
  taxRate: string;
  taxAmount: string;
  lineTotal: string;
}

export interface Quotation {
  id: string;
  organisationId: string;
  customerId: string;
  quotationNumber: string;
  issueDate: string;
  validUntil: string | null;
  status: QuotationStatus;
  currencyCode: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  totalAmount: string;
  notes: string | null;
  terms: string | null;
  createdBy: string;
  sentAt: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  convertedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  customer?: Pick<Customer, 'id' | 'companyName' | 'contactName'>;
}

export interface QuotationDetail extends Quotation {
  items: QuotationItem[];
  customer: Customer;
  invoices: Array<{ id: string; invoiceNumber: string; status: string }>;
}

export interface QuotationListParams {
  page?: number;
  limit?: number;
  search?: string;
  status?: QuotationStatus;
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
  sort?: 'issueDate' | 'quotationNumber' | 'totalAmount';
  direction?: 'asc' | 'desc';
}

export function listQuotations(params: QuotationListParams = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch<Paginated<Quotation>>(`/quotations${suffix}`);
}

export const getQuotation = (id: string) => apiFetch<QuotationDetail>(`/quotations/${id}`);

/**
 * Line item as held by the form.
 *
 * All numeric fields are strings end to end — the API expects decimal strings
 * and the frontend performs no money arithmetic (Frontend Spec §37).
 */
export interface LineItemDraft {
  /** Client-side key for React list stability; never sent. */
  key: string;
  /** Set when the line was picked from the product list; drives stock deduction. */
  stockItemId: string | null;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountRate: string;
  taxRate: string;
}

export interface QuotationFormValues {
  customerId: string;
  issueDate: string;
  validUntil: string;
  items: LineItemDraft[];
  discountRate: string;
  notes: string;
  terms: string;
}

function toPayload(values: QuotationFormValues) {
  return {
    customerId: values.customerId,
    issueDate: values.issueDate,
    validUntil: values.validUntil || null,
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
      values.discountRate && Number(values.discountRate) > 0
        ? { rate: values.discountRate }
        : null,
    notes: values.notes.trim() || null,
    terms: values.terms.trim() || null,
  };
}

export const createQuotation = (values: QuotationFormValues) =>
  apiFetch<QuotationDetail>('/quotations', { method: 'POST', json: toPayload(values) });

export const updateQuotation = (id: string, values: QuotationFormValues, expectedVersion?: number) =>
  apiFetch<QuotationDetail>(`/quotations/${id}`, {
    method: 'PATCH',
    json: { ...toPayload(values), expectedVersion },
  });

// --- lifecycle ---------------------------------------------------------------

export const sendQuotation = (id: string) =>
  apiFetch<Quotation>(`/quotations/${id}/send`, { method: 'POST' });

export const acceptQuotation = (id: string) =>
  apiFetch<Quotation>(`/quotations/${id}/accept`, { method: 'POST' });

export const rejectQuotation = (id: string, reason?: string) =>
  apiFetch<Quotation>(`/quotations/${id}/reject`, {
    method: 'POST',
    json: { reason: reason?.trim() || null },
  });

export const cancelQuotation = (id: string, reason?: string) =>
  apiFetch<Quotation>(`/quotations/${id}/cancel`, {
    method: 'POST',
    json: { reason: reason?.trim() || null },
  });

export const duplicateQuotation = (id: string) =>
  apiFetch<QuotationDetail>(`/quotations/${id}/duplicate`, { method: 'POST' });

export const convertQuotation = (id: string, paymentMethod?: string) =>
  apiFetch<{
    invoice: { id: string; invoiceNumber: string; status: string; totalAmount: string };
    alreadyConverted: boolean;
  }>(`/quotations/${id}/convert-to-invoice`, {
    method: 'POST',
    // Omitted rather than sent empty: the field is optional on conversion and
    // "" is not a valid enum value.
    json: paymentMethod ? { paymentMethod } : {},
  });

export const getQuotationPdfUrl = (id: string) =>
  apiFetch<{ url: string; fileName: string; expiresInSeconds: number }>(`/quotations/${id}/pdf`);

// --- helpers -----------------------------------------------------------------

export const QUOTATION_STATUS_TONE: Record<QuotationStatus, 'gray' | 'blue' | 'green' | 'red' | 'orange'> = {
  DRAFT: 'gray',
  SENT: 'blue',
  ACCEPTED: 'green',
  REJECTED: 'red',
  EXPIRED: 'orange',
  CONVERTED: 'green',
  CANCELLED: 'gray',
};

/**
 * Which actions the UI should offer for a status.
 *
 * Mirrors the server's transition table. This decides what to *show*; the API
 * decides what to *allow* — hiding a button is not enforcement
 * (Security Doc §12).
 */
export function availableActions(status: QuotationStatus) {
  return {
    canEdit: status === 'DRAFT',
    canSend: status === 'DRAFT',
    canAccept: status === 'SENT',
    canReject: status === 'SENT',
    canCancel: status === 'DRAFT' || status === 'SENT' || status === 'ACCEPTED',
    canConvert: status === 'ACCEPTED',
    canDuplicate: true,
  };
}

export const emptyLineItem = (): LineItemDraft => ({
  key: crypto.randomUUID(),
  stockItemId: null,
  description: '',
  quantity: '1',
  unit: '',
  unitPrice: '',
  discountRate: '',
  taxRate: '',
});

export function emptyQuotationForm(defaultTaxRate = '0'): QuotationFormValues {
  const today = new Date().toISOString().slice(0, 10);
  const validUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

  return {
    customerId: '',
    issueDate: today,
    validUntil,
    items: [{ ...emptyLineItem(), taxRate: defaultTaxRate }],
    discountRate: '',
    notes: '',
    terms: '',
  };
}

export function quotationToForm(quotation: QuotationDetail): QuotationFormValues {
  return {
    customerId: quotation.customerId,
    issueDate: quotation.issueDate.slice(0, 10),
    validUntil: quotation.validUntil?.slice(0, 10) ?? '',
    items: quotation.items.map((item) => ({
      key: item.id,
      stockItemId: item.stockItemId ?? null,
      description: item.description,
      quantity: trimZeros(item.quantity),
      unit: item.unit ?? '',
      unitPrice: trimZeros(item.unitPrice),
      discountRate: Number(item.discountRate) > 0 ? trimZeros(item.discountRate) : '',
      taxRate: trimZeros(item.taxRate),
    })),
    // The document-level discount is stored as an amount; the form edits a
    // rate, so an existing amount-based discount is not round-tripped here.
    // Editing is DRAFT-only and Phase 2 UI offers rate-based discounts only.
    discountRate: '',
    notes: quotation.notes ?? '',
    terms: quotation.terms ?? '',
  };
}

/** "2.5000" -> "2.5", "3.0000" -> "3" */
function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}
