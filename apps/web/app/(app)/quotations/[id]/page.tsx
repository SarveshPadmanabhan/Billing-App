'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft,
  Pencil,
  Send,
  Check,
  X,
  Copy,
  FileDown,
  ArrowRightLeft,
  Ban,
} from 'lucide-react';
import type { CurrentUserResponse } from '@billing/types';
import { hasPermission } from '@billing/types';
import { apiFetch, ApiRequestError } from '../../../../lib/api-client';
import {
  getQuotation,
  sendQuotation,
  acceptQuotation,
  rejectQuotation,
  cancelQuotation,
  duplicateQuotation,
  convertQuotation,
  getQuotationPdfUrl,
  availableActions,
  QUOTATION_STATUS_TONE,
} from '../../../../lib/quotations';
import { customerName } from '../../../../lib/customers';
import {
  Button,
  Card,
  Badge,
  Money,
  Modal,
  Input,
  Select,
  Field,
  ErrorState,
  TableSkeleton,
} from '../../../../components/ui/primitives';

/** TICKET-019, 020, 021, 022 — quotation detail and actions. */

const humanStatus = (s: string) =>
  s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

type DialogKind = 'send' | 'accept' | 'reject' | 'cancel' | 'convert' | null;

export default function QuotationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = String(params?.id ?? '');

  const [dialog, setDialog] = useState<DialogKind>(null);
  const [convertPaymentMethod, setConvertPaymentMethod] = useState('');
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: me } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<CurrentUserResponse>('/auth/me'),
  });

  const { data: quotation, isLoading, error, refetch } = useQuery({
    queryKey: ['quotations', id],
    queryFn: () => getQuotation(id),
    enabled: Boolean(id),
  });

  const role = me?.organisation?.role;
  const permissions = me?.organisation?.permissions ?? [];
  const canWrite = role ? hasPermission(role, 'quotation:write') : false;
  const canSend = role ? hasPermission(role, 'quotation:send') : false;
  // Convert is config-gated for SALES, so trust the server's permission list
  // rather than recomputing the rule here.
  const canConvert = permissions.includes('quotation:convert');

  async function run(action: () => Promise<unknown>, onDone?: () => void) {
    setWorking(true);
    setActionError(null);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ['quotations'] });
      setDialog(null);
      setReason('');
      onDone?.();
    } catch (err) {
      setActionError(
        err instanceof ApiRequestError ? err.message : 'Something went wrong. Please try again.',
      );
    } finally {
      setWorking(false);
    }
  }

  async function download() {
    setWorking(true);
    setActionError(null);
    try {
      const { url } = await getQuotationPdfUrl(id);
      // Signed URL from object storage; opening it downloads the file.
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setActionError(
        err instanceof ApiRequestError ? err.message : 'We could not generate the PDF.',
      );
    } finally {
      setWorking(false);
    }
  }

  if (isLoading) return <TableSkeleton rows={6} columns={4} />;

  if (error) {
    const missing = error instanceof ApiRequestError && error.status === 404;
    return (
      <ErrorState
        message={missing ? 'This quotation could not be found.' : 'We could not load this quotation.'}
        onRetry={missing ? undefined : () => refetch()}
      />
    );
  }

  if (!quotation) return null;

  const actions = availableActions(quotation.status);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/quotations"
          className="inline-flex items-center gap-1 text-body-sm text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Quotations
        </Link>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-h1 text-ink">{quotation.quotationNumber}</h1>
              <Badge tone={QUOTATION_STATUS_TONE[quotation.status]}>
                {humanStatus(quotation.status)}
              </Badge>
            </div>
            <p className="mt-1 text-body text-ink-muted">
              <Link
                href={`/customers/${quotation.customerId}`}
                className="text-primary hover:underline"
              >
                {customerName(quotation.customer)}
              </Link>
              {' · '}
              {formatDate(quotation.issueDate)}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={download} loading={working}>
              <FileDown className="h-4 w-4" aria-hidden="true" />
              PDF
            </Button>

            {canWrite && actions.canEdit && (
              <Link href={`/quotations/${id}/edit`}>
                <Button variant="secondary">
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  Edit
                </Button>
              </Link>
            )}

            {canWrite && actions.canDuplicate && (
              <Button
                variant="secondary"
                onClick={() =>
                  run(async () => {
                    const copy = await duplicateQuotation(id);
                    router.push(`/quotations/${copy.id}`);
                  })
                }
                disabled={working}
              >
                <Copy className="h-4 w-4" aria-hidden="true" />
                Duplicate
              </Button>
            )}

            {canSend && actions.canSend && (
              <Button onClick={() => setDialog('send')}>
                <Send className="h-4 w-4" aria-hidden="true" />
                Send
              </Button>
            )}

            {canWrite && actions.canAccept && (
              <Button onClick={() => setDialog('accept')}>
                <Check className="h-4 w-4" aria-hidden="true" />
                Mark accepted
              </Button>
            )}

            {canWrite && actions.canReject && (
              <Button variant="secondary" onClick={() => setDialog('reject')}>
                <X className="h-4 w-4" aria-hidden="true" />
                Mark rejected
              </Button>
            )}

            {canConvert && actions.canConvert && (
              <Button onClick={() => setDialog('convert')}>
                <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />
                Convert to invoice
              </Button>
            )}

            {canWrite && actions.canCancel && (
              <Button variant="destructive" onClick={() => setDialog('cancel')}>
                <Ban className="h-4 w-4" aria-hidden="true" />
                Cancel
              </Button>
            )}
          </div>
        </div>
      </div>

      {actionError && (
        <div role="alert" className="rounded-sm bg-danger-light p-3 text-body-sm text-danger">
          {actionError}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded-sm bg-success-light p-3 text-body-sm text-success">
          {notice}
        </div>
      )}

      {quotation.invoices.length > 0 && (
        <Card className="border-success/30 bg-success-light">
          <p className="text-body text-ink">
            Converted to{' '}
            {quotation.invoices.map((invoice, index) => (
              <span key={invoice.id}>
                {index > 0 && ', '}
                <Link href={`/invoices/${invoice.id}`} className="font-medium text-primary hover:underline">
                  {invoice.invoiceNumber}
                </Link>
              </span>
            ))}
            .
          </p>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="min-w-0 lg:col-span-1">
          <h2 className="text-h4 text-ink">Details</h2>
          <dl className="mt-4 flex flex-col gap-3">
            <Detail label="Customer" value={customerName(quotation.customer)} />
            <Detail label="Quotation date" value={formatDate(quotation.issueDate)} />
            <Detail
              label="Valid until"
              value={quotation.validUntil ? formatDate(quotation.validUntil) : '—'}
            />
            {quotation.sentAt && <Detail label="Sent" value={formatDate(quotation.sentAt)} />}
            {quotation.acceptedAt && (
              <Detail label="Accepted" value={formatDate(quotation.acceptedAt)} />
            )}
            {quotation.rejectedAt && (
              <Detail label="Rejected" value={formatDate(quotation.rejectedAt)} />
            )}
            {quotation.convertedAt && (
              <Detail label="Converted" value={formatDate(quotation.convertedAt)} />
            )}
          </dl>
        </Card>

        <Card className="min-w-0 p-0 lg:col-span-2">
          <h2 className="border-b border-border p-5 text-h4 text-ink">Items</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <caption className="sr-only">Quotation line items</caption>
              <thead>
                <tr className="border-b border-border bg-canvas">
                  <th scope="col" className="p-3 text-left text-caption font-semibold text-ink-secondary">
                    Description
                  </th>
                  <th scope="col" className="p-3 text-right text-caption font-semibold text-ink-secondary">
                    Qty
                  </th>
                  <th scope="col" className="p-3 text-right text-caption font-semibold text-ink-secondary">
                    Rate
                  </th>
                  {/* Post-discount base for this line's tax — mirrors the PDF. */}
                  <th scope="col" className="p-3 text-right text-caption font-semibold text-ink-secondary">
                    Taxable
                  </th>
                  <th scope="col" className="p-3 text-right text-caption font-semibold text-ink-secondary">
                    Tax
                  </th>
                  <th scope="col" className="p-3 text-right text-caption font-semibold text-ink-secondary">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {quotation.items.map((item) => {
                  const taxable = (Number(item.lineTotal) - Number(item.taxAmount)).toFixed(4);
                  return (
                    <tr key={item.id} className="border-b border-border last:border-b-0">
                      <td className="p-3 text-body text-ink">{item.description}</td>
                      <td className="p-3 text-right text-body tabular text-ink-secondary">
                        {Number(item.quantity)}
                        {item.unit ? ` ${item.unit}` : ''}
                      </td>
                      <td className="p-3 text-right text-body text-ink-secondary">
                        <Money amount={item.unitPrice} currency={quotation.currencyCode} />
                      </td>
                      <td className="p-3 text-right text-body text-ink-secondary">
                        <Money amount={taxable} currency={quotation.currencyCode} />
                      </td>
                      <td className="p-3 text-right text-body text-ink-secondary">
                        {Number(item.taxRate)}% ·{' '}
                        <Money amount={item.taxAmount} currency={quotation.currencyCode} />
                      </td>
                      <td className="p-3 text-right text-body font-medium text-ink">
                        <Money amount={item.lineTotal} currency={quotation.currencyCode} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex justify-end overflow-x-auto border-t border-border p-5">
            <table className="min-w-[260px]">
              <caption className="sr-only">Totals</caption>
              <tbody>
                <tr>
                  <td className="py-1 text-body text-ink-secondary">Subtotal</td>
                  <td className="py-1 text-right text-body text-ink">
                    <Money amount={quotation.subtotal} currency={quotation.currencyCode} />
                  </td>
                </tr>
                {Number(quotation.discountAmount) > 0 && (
                  <tr>
                    <td className="py-1 text-body text-ink-secondary">Discount</td>
                    <td className="py-1 text-right text-body text-ink">
                      −<Money amount={quotation.discountAmount} currency={quotation.currencyCode} />
                    </td>
                  </tr>
                )}
                <tr>
                  <td className="py-1 text-body text-ink-secondary">Tax</td>
                  <td className="py-1 text-right text-body text-ink">
                    <Money amount={quotation.taxAmount} currency={quotation.currencyCode} />
                  </td>
                </tr>
                <tr className="border-t border-border-strong">
                  <td className="pt-2 text-h4 text-ink">Total</td>
                  <td className="pt-2 text-right text-h4 text-ink">
                    <Money amount={quotation.totalAmount} currency={quotation.currencyCode} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {(quotation.notes || quotation.terms) && (
        <Card className="flex flex-col gap-4">
          {quotation.notes && (
            <div>
              <h2 className="text-caption font-semibold uppercase tracking-wide text-ink-muted">
                Notes
              </h2>
              <p className="mt-1 whitespace-pre-wrap text-body text-ink">{quotation.notes}</p>
            </div>
          )}
          {quotation.terms && (
            <div>
              <h2 className="text-caption font-semibold uppercase tracking-wide text-ink-muted">
                Terms
              </h2>
              <p className="mt-1 whitespace-pre-wrap text-body text-ink">{quotation.terms}</p>
            </div>
          )}
        </Card>
      )}

      {/* --- dialogs --- */}

      <Modal
        open={dialog === 'send'}
        onClose={() => setDialog(null)}
        title="Send this quotation?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)} disabled={working}>
              Cancel
            </Button>
            <Button loading={working} onClick={() => run(() => sendQuotation(id))}>
              Send quotation
            </Button>
          </>
        }
      >
        <p>
          {quotation.quotationNumber} will be marked as sent and its PDF generated. Once sent, the
          quotation can no longer be edited — duplicate it if you need changes.
        </p>
      </Modal>

      <Modal
        open={dialog === 'accept'}
        onClose={() => setDialog(null)}
        title="Mark as accepted?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)} disabled={working}>
              Cancel
            </Button>
            <Button loading={working} onClick={() => run(() => acceptQuotation(id))}>
              Mark accepted
            </Button>
          </>
        }
      >
        <p>Record that the customer accepted this quotation. You can then convert it to an invoice.</p>
      </Modal>

      <Modal
        open={dialog === 'reject'}
        onClose={() => setDialog(null)}
        title="Mark as rejected?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)} disabled={working}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={working}
              onClick={() => run(() => rejectQuotation(id, reason))}
            >
              Mark rejected
            </Button>
          </>
        }
      >
        <p>A rejected quotation cannot be accepted or converted later.</p>
        <div className="mt-4">
          <label htmlFor="reject-reason" className="text-body-sm font-medium text-ink">
            Reason (optional)
          </label>
          <Input
            id="reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-2"
          />
        </div>
      </Modal>

      <Modal
        open={dialog === 'cancel'}
        onClose={() => setDialog(null)}
        title="Cancel this quotation?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)} disabled={working}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              loading={working}
              onClick={() => run(() => cancelQuotation(id, reason))}
            >
              Cancel quotation
            </Button>
          </>
        }
      >
        <p>
          {quotation.quotationNumber} will be cancelled. It stays in your records for history but
          cannot be sent, accepted or converted.
        </p>
        <div className="mt-4">
          <label htmlFor="cancel-reason" className="text-body-sm font-medium text-ink">
            Reason (optional)
          </label>
          <Input
            id="cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-2"
          />
        </div>
      </Modal>

      <Modal
        open={dialog === 'convert'}
        onClose={() => setDialog(null)}
        title="Convert to invoice?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)} disabled={working}>
              Cancel
            </Button>
            <Button
              loading={working}
              onClick={() =>
                run(async () => {
                  const result = await convertQuotation(id, convertPaymentMethod || undefined);
                  setNotice(
                    result.alreadyConverted
                      ? `Already converted to ${result.invoice.invoiceNumber}.`
                      : `Invoice ${result.invoice.invoiceNumber} created.`,
                  );
                })
              }
            >
              Create invoice
            </Button>
          </>
        }
      >
        <p>
          A draft invoice will be created with the same customer, items and amounts. The quotation
          is kept and marked as converted.
        </p>
        <p className="mt-2 text-body-sm text-ink-muted">
          Amounts are carried across exactly as quoted, so the invoice matches what the customer
          accepted.
        </p>
        <div className="mt-4">
          <Field
            label="Mode of payment"
            htmlFor="convertPaymentMethod"
            hint="Optional here — it can be set on the draft before sending."
          >
            <Select
              id="convertPaymentMethod"
              value={convertPaymentMethod}
              onChange={(e) => setConvertPaymentMethod(e.target.value)}
            >
              <option value="">Not decided yet</option>
              <option value="CASH">Cash</option>
              <option value="BANK_TRANSFER">Bank transfer</option>
              <option value="CARD">Card</option>
              <option value="CHEQUE">Cheque</option>
              <option value="UPI">UPI</option>
              <option value="OTHER">Other</option>
            </Select>
          </Field>
        </div>
      </Modal>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-caption text-ink-muted">{label}</dt>
      <dd className="text-body text-ink">{value}</dd>
    </div>
  );
}
