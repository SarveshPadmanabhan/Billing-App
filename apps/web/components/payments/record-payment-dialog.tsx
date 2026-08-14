'use client';

import { useState, useMemo } from 'react';
import { ApiRequestError } from '../../lib/api-client';
import {
  recordPayment,
  todayIso,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  type PaymentMethod,
  type RecordPaymentValues,
} from '../../lib/payments';
import { Button, Modal, Input, Select, Field, Money } from '../ui/primitives';

/**
 * Record-payment dialog (TICKET-031).
 *
 * The idempotency key is generated once when the dialog opens and reused for
 * every submit attempt from that dialog. That is what makes a double-click or
 * a retry after a network wobble resolve to the payment already recorded
 * rather than taking the money a second time (Security Doc §19).
 *
 * A new key is only minted when the dialog is reopened, which is the correct
 * boundary: reopening means the user intends a *different* payment.
 */
export function RecordPaymentDialog({
  open,
  onClose,
  invoiceId,
  invoiceNumber,
  amountDue,
  currency,
  onRecorded,
}: {
  open: boolean;
  onClose: () => void;
  invoiceId: string;
  invoiceNumber: string;
  amountDue: string;
  currency: string;
  onRecorded: (result: { invoiceStatus: string; replayed: boolean }) => void;
}) {
  // Keyed on `open` so each opening of the dialog gets one stable key.
  const idempotencyKey = useMemo(
    () => (open ? `pay-${crypto.randomUUID()}` : ''),
    [open],
  );

  const [values, setValues] = useState<RecordPaymentValues>({
    // Defaults to settling the invoice in full — the common case.
    amount: amountDue,
    paymentDate: todayIso(),
    paymentMethod: 'BANK_TRANSFER',
    reference: '',
    notes: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset when the dialog reopens. Without this, a second payment on the same
  // invoice would prefill the previous (now stale) balance, and any error from
  // the earlier attempt would still be on screen.
  const [lastOpenedKey, setLastOpenedKey] = useState(idempotencyKey);
  if (open && idempotencyKey !== lastOpenedKey) {
    setLastOpenedKey(idempotencyKey);
    setValues({
      amount: amountDue,
      paymentDate: todayIso(),
      paymentMethod: 'BANK_TRANSFER',
      reference: '',
      notes: '',
    });
    setErrors({});
    setFormError(null);
    setSubmitting(false);
  }

  function set<K extends keyof RecordPaymentValues>(key: K, value: RecordPaymentValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    const amount = Number(values.amount);

    if (!values.amount || Number.isNaN(amount) || amount <= 0) {
      next.amount = 'Enter an amount greater than zero';
    } else if (amount > Number(amountDue)) {
      // Mirrors the server rule so the user sees it before a round trip.
      next.amount = `Cannot exceed the outstanding balance of ${amountDue}`;
    }

    if (!values.paymentDate) {
      next.paymentDate = 'Payment date is required';
    } else if (values.paymentDate > todayIso()) {
      next.paymentDate = 'Payment date cannot be in the future';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit() {
    if (submitting) return;
    if (!validate()) return;

    setSubmitting(true);
    setFormError(null);

    try {
      const result = await recordPayment(invoiceId, values, idempotencyKey);
      onRecorded({
        invoiceStatus: result.invoice?.status ?? 'UNKNOWN',
        replayed: result.replayed,
      });
      onClose();
    } catch (error) {
      if (error instanceof ApiRequestError) {
        if (error.details?.length) {
          setErrors(Object.fromEntries(error.details.map((d) => [d.field, d.message])));
        }
        setFormError(error.message);
      } else {
        // Deliberately does NOT tell the user "no payment was recorded" — a
        // network failure after the request reached the server may well have
        // recorded it. Retrying is safe because the key is unchanged
        // (Security Doc §23).
        setFormError('We could not confirm this payment. Check the invoice before retrying.');
      }
      setSubmitting(false);
    }
  }

  const remaining = (Number(amountDue) - Number(values.amount || 0)).toFixed(4);
  const settlesInvoice = Number(values.amount) === Number(amountDue);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Record a payment for ${invoiceNumber}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button loading={submitting} onClick={submit}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {formError && (
          <div role="alert" className="rounded-sm bg-danger-light p-3 text-body-sm text-danger">
            {formError}
          </div>
        )}

        <p className="text-body text-ink-secondary">
          Outstanding balance:{' '}
          <span className="font-medium text-ink">
            <Money amount={amountDue} currency={currency} />
          </span>
        </p>

        <Field label="Amount" htmlFor="payment-amount" error={errors.amount} required>
          <Input
            id="payment-amount"
            inputMode="decimal"
            className="tabular text-right"
            value={values.amount}
            invalid={Boolean(errors.amount)}
            onChange={(e) => set('amount', e.target.value)}
          />
        </Field>

        {!errors.amount && Number(values.amount) > 0 && (
          <p className="-mt-2 text-caption text-ink-muted">
            {settlesInvoice ? (
              'This settles the invoice in full.'
            ) : (
              <>
                Leaves <Money amount={remaining} currency={currency} /> outstanding.
              </>
            )}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Payment date" htmlFor="payment-date" error={errors.paymentDate} required>
            <Input
              id="payment-date"
              type="date"
              max={todayIso()}
              value={values.paymentDate}
              invalid={Boolean(errors.paymentDate)}
              onChange={(e) => set('paymentDate', e.target.value)}
            />
          </Field>

          <Field label="Method" htmlFor="payment-method" required>
            <Select
              id="payment-method"
              value={values.paymentMethod}
              onChange={(e) => set('paymentMethod', e.target.value as PaymentMethod)}
            >
              {PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {PAYMENT_METHOD_LABELS[method]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field
          label="Reference"
          htmlFor="payment-reference"
          hint="Transaction id, cheque number, or similar."
        >
          <Input
            id="payment-reference"
            value={values.reference}
            onChange={(e) => set('reference', e.target.value)}
          />
        </Field>

        <Field label="Notes" htmlFor="payment-notes">
          <Input
            id="payment-notes"
            value={values.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
