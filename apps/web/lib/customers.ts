import { apiFetch } from './api-client';
import type { Paginated } from '@billing/types';

/**
 * Customer API bindings for the web app.
 *
 * These mirror the server schemas but are NOT the validation boundary — the
 * API re-validates everything. Client-side checks exist for fast feedback only
 * (Frontend Spec §37).
 */

export interface Customer {
  id: string;
  organisationId: string;
  customerType: 'INDIVIDUAL' | 'COMPANY';
  companyName: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  taxNumber: string | null;
  billingAddressLine1: string | null;
  billingAddressLine2: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingPostalCode: string | null;
  billingCountryCode: string | null;
  shippingAddressLine1: string | null;
  shippingAddressLine2: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingPostalCode: string | null;
  shippingCountryCode: string | null;
  notes: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  outstanding?: string;
}

export interface CustomerBillingHistory {
  customer: Customer;
  totals: {
    totalQuoted: string;
    totalInvoiced: string;
    totalPaid: string;
    outstanding: string;
  };
  quotations: Array<{
    id: string;
    quotationNumber: string;
    issueDate: string;
    validUntil: string | null;
    status: string;
    currencyCode: string;
    totalAmount: string;
  }>;
  invoices: Array<{
    id: string;
    invoiceNumber: string;
    issueDate: string;
    dueDate: string;
    status: string;
    currencyCode: string;
    totalAmount: string;
    amountPaid: string;
    amountDue: string;
  }>;
  payments: Array<{
    id: string;
    paymentNumber: string;
    paymentDate: string;
    amount: string;
    currencyCode: string;
    paymentMethod: string;
    reference: string | null;
  }>;
}

export interface CustomerListParams {
  page?: number;
  limit?: number;
  search?: string;
  status?: 'active' | 'archived' | 'all';
  sort?: 'createdAt' | 'companyName' | 'outstanding';
  direction?: 'asc' | 'desc';
}

export function listCustomers(params: CustomerListParams = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query}` : '';
  return apiFetch<Paginated<Customer>>(`/customers${suffix}`);
}

export const getCustomer = (id: string) => apiFetch<Customer>(`/customers/${id}`);

export const getCustomerBillingHistory = (id: string) =>
  apiFetch<CustomerBillingHistory>(`/customers/${id}/billing-history`);

export interface CustomerFormValues {
  customerType: 'INDIVIDUAL' | 'COMPANY';
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  taxNumber: string;
  billing: {
    addressLine1: string;
    addressLine2: string;
    city: string;
    state: string;
    postalCode: string;
    countryCode: string;
  };
  shippingSameAsBilling: boolean;
  shipping: {
    addressLine1: string;
    addressLine2: string;
    city: string;
    state: string;
    postalCode: string;
    countryCode: string;
  };
  notes: string;
}

/** Blank strings become null so the API's optional fields stay clean. */
const nullify = (value: string) => (value.trim() === '' ? null : value.trim());

function toPayload(values: CustomerFormValues) {
  const address = (a: CustomerFormValues['billing']) => ({
    addressLine1: nullify(a.addressLine1),
    addressLine2: nullify(a.addressLine2),
    city: nullify(a.city),
    state: nullify(a.state),
    postalCode: nullify(a.postalCode),
    countryCode: nullify(a.countryCode),
  });

  return {
    companyName: nullify(values.companyName),
    contactName: nullify(values.contactName),
    email: nullify(values.email),
    phone: nullify(values.phone),
    taxNumber: nullify(values.taxNumber),
    billing: address(values.billing),
    shipping: values.shippingSameAsBilling ? undefined : address(values.shipping),
    shippingSameAsBilling: values.shippingSameAsBilling,
    notes: nullify(values.notes),
  };
}

export const createCustomer = (values: CustomerFormValues) =>
  apiFetch<Customer>('/customers', {
    method: 'POST',
    json: { customerType: values.customerType, ...toPayload(values) },
  });

/**
 * `expectedUpdatedAt` carries the timestamp the form was loaded with, so a
 * concurrent edit by someone else is rejected rather than silently overwritten
 * (Security Doc §24).
 */
export const updateCustomer = (id: string, values: CustomerFormValues, expectedUpdatedAt?: string) =>
  apiFetch<Customer>(`/customers/${id}`, {
    method: 'PATCH',
    json: { ...toPayload(values), expectedUpdatedAt },
  });

export const archiveCustomer = (id: string, reason?: string) =>
  apiFetch<Customer & { openInvoices: number }>(`/customers/${id}/archive`, {
    method: 'POST',
    json: { confirm: true, reason: reason?.trim() || null },
  });

export const restoreCustomer = (id: string) =>
  apiFetch<Customer>(`/customers/${id}/restore`, { method: 'POST' });

/** Display name, independent of customer type. */
export const customerName = (c: Pick<Customer, 'companyName' | 'contactName'>) =>
  c.companyName || c.contactName || 'Unnamed customer';
