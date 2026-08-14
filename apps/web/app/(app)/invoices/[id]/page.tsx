'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Pencil, Send, Copy, FileDown, Ban, AlertTriangle, Banknote, Undo2 } from 'lucide-react';
import type { CurrentUserResponse } from '@billing/types';
import { hasPermission } from '@billing/types';
import { apiFetch, ApiRequestError } from '../../../../lib/api-client';
import {
  getInvoice,
  sendInvoice,
  cancelInvoice,
  duplicateInvoice,
  getInvoicePdfUrl,
  invoiceActions,
  INVOICE_STATUS_TONE,
} from '../../../../lib/invoices';
import { customerName } from '../../../../lib/customers';
import { voidPayment, paymentMethodLabel } from '../../../../lib/payments';
import { RecordPaymentDialog } from '../../../../components/payments/record-payment-dialog';
import {
  Button,
  Card,
  Badge,
  Money,
  Modal,
  Input,
  ErrorState,
  TableSkeleton,
} from '../../../../components/ui/primitives';

/** TICKET-028, 029, 030 — invoice detail and actions. */

const humanStatus = (s: string) =>
  s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export default function InvoiceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = String(params?.id ?? '');

  const [dialog, setDialog] = useState<'send' | 'cancel' | 'void' | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<{ id: string; number: string } | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: me } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<CurrentUserResponse>('/auth/me'),
  });

  const { data: invoice, isLoading, error, refetch } = useQuery({
    queryKey: ['invoices', id],
    queryFn: () => getInvoice(id),
    enabled: Boolean(id),
  });

  const role = me?.organisation?.role;
  const canWrite = role ? hasPermission(role, 'invoice:write') : false;
  const canSend = role ? hasPermission(role, 'invoice:send') : false;
  // Base grant only. The server applies the record-state rule — BILLING may
  // cancel a draft or sent invoice but not one that has been paid — so a 403
  // here is expected and surfaced rather than pre-empted.
  const canCancel = role ? hasPermission(role, 'invoice:cancel') : false;
  const canRecordPayment = role ? hasPermission(role, 'payment:record') : false;
  // Base grant only — BILLING may void just the payments it recorded, which
  // the server checks against the loaded record.
  const canVoid = role ? hasPermission(role, 'payment:void') : false;

  async function run(action: () => Promise<unknown>, onDone?: () => void) {
    setWorking(true);
    setActionError(null);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: ['invoices'] });
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
      const { url } = await getInvoicePdfUrl(id);
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
        message={missing ? 'This invoice could not be found.' : 'We could not load this invoice.'}
        onRetry={missing ? undefined : () => refetch()}
      />
    );
  }

  if (!invoice) return null;

  const actions = invoiceActions(invoice);
  const pastDue =
    Number(invoice.amountDue) > 0 &&
    new Date(invoice.dueDate) < new Date() &&
    invoice.status !== 'DRAFT' &&
    invoice.status !== 'CANCELLED';

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/invoices"
          className="inline-flex items-center gap-1 text-body-sm text-ink-muted hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Invoices
        </Link>

        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-h1 text-ink">{invoice.invoiceNumber}</h1>
              <Badge tone={INVOICE_STATUS_TONE[invoice.status]}>
                {humanStatus(invoice.status)}
              </Badge>
            </div>
            <p className="mt-1 text-body text-ink-muted">
              <Link
                href={`/customers/${invoice.customerId}`}
                className="text-primary hover:underline"
              >
                {customerName(invoice.customer)}
              </Link>
              {' · issued '}
              {formatDate(invoice.issueDate)}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={download} loading={working}>
              <FileDown className="h-4 w-4" aria-hidden="true" />
              PDF
            </Button>

            {canWrite && actions.canEdit && (
              <Link href={`/invoices/${id}/edit`}>
                <Button variant="secondary">
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  Edit
                </Button>
              </Link>
            )}

            {canWrite && actions.canDuplicate && (
              <Button
                variant="secondary"
                disabled={working}
                onClick={() =>
                  run(async () => {
                    const copy = await duplicateInvoice(id);
                    router.push(`/invoices/${copy.id}`);
                  })
                }
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

            {canRecordPayment && actions.canRecordPayment && (
              <Button onClick={() => setPayOpen(true)}>
                <Banknote className="h-4 w-4" aria-hidden="true" />
                Record payment
              </Button>
            )}

            {canCancel && actions.canCancel && (
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

      {pastDue && (
        <Card className="flex items-center gap-2 border-danger/30 bg-danger-light">
          <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
          <p className="text-body text-ink">
            This invoice was due on {formatDate(invoice.dueDate)} and has an outstanding balance of{' '}
            <Money amount={invoice.amountDue} currency={invoice.currencyCode} />.
          </p>
        </Card>
      )}

      {invoice.status === 'CANCELLED' && invoice.cancelledReason && (
        <Card className="bg-canvas">
          <p className="text-body text-ink">
            <span className="font-medium">Cancelled</span>
            {invoice.cancelledAt && ` on ${formatDate(invoice.cancelledAt)}`}:{' '}
            {invoice.cancelledReason}
          </p>
        </Card>
      )}

      {invoice.quotation && (
        <Card className="bg-canvas">
          <p className="text-body text-ink">
            Converted from quotation{' '}
            <Link
              href={`/quotations/${invoice.quotation.id}`}
              className="font-medium text-primary hover:underline"
            >
              {invoice.quotation.quotationNumber}
            </Link>
            .
          </p>
        </Card>
      )}

      {/* Balance summary — the figures a user checks first. */}
      <section aria-label="Balance" className="grid gap-4 sm:grid-cols-3">
        <Card>
          <h2 className="text-body-sm font-medium text-ink-secondary">Invoice total</h2>
          <p className="mt-2 text-h3 text-ink">
            <Money amount={invoice.totalAmount} currency={invoice.currencyCode} />
          </p>
        </Card>
        <Card>
          <h2 className="text-body-sm font-medium text-ink-secondary">Paid</h2>
          <p className="mt-2 text-h3 text-success">
            <Money amount={invoice.amountPaid} currency={invoice.currencyCode} />
          </p>
        </Card>
        <Card>
          <h2 className="text-body-sm font-medium text-ink-secondary">Balance due</h2>
          <p
            className={`mt-2 text-h3 ${Number(invoice.amountDue) > 0 ? 'text-danger' : 'text-ink'}`}
          >
            <Money amount={invoice.amountDue} currency={invoice.currencyCode} />
          </p>
        </Card>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="min-w-0 lg:col-span-1">
          <h2 className="text-h4 text-ink">Details</h2>
          <dl className="mt-4 flex flex-col gap-3">
            <Detail label="Customer" value={customerName(invoice.customer)} />
            <Detail label="Invoice date" value={formatDate(invoice.issueDate)} />
            <Detail label="Due date" value={formatDate(invoice.dueDate)} />
            {invoice.sentAt && <Detail label="Sent" value={formatDate(invoice.sentAt)} />}
            {invoice.paidAt && <Detail label="Paid" value={formatDate(invoice.paidAt)} />}
          </dl>
        </Card>

        <Card className="min-w-0 p-0 lg:col-span-2">
          <h2 className="border-b border-border p-5 text-h4 text-ink">Items</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <caption className="sr-only">Invoice line items</caption>
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
                {invoice.items.map((item) => {
                  const taxable = (Number(item.lineTotal) - Number(item.taxAmount)).toFixed(4);
                  return (
                    <tr key={item.id} className="border-b border-border last:border-b-0">
                      <td className="p-3 text-body text-ink">{item.description}</td>
                      <td className="p-3 text-right text-body tabular text-ink-secondary">
                        {Number(item.quantity)}
                        {item.unit ? ` ${item.unit}` : ''}
                      </td>
                      <td className="p-3 text-right text-body text-ink-secondary">
                        <Money amount={item.unitPrice} currency={invoice.currencyCode} />
                      </td>
                      <td className="p-3 text-right text-body text-ink-secondary">
                        <Money amount={taxable} currency={invoice.currencyCode} />
                      </td>
                      <td className="p-3 text-right text-body text-ink-secondary">
                        {Number(item.taxRate)}% ·{' '}
                        <Money amount={item.taxAmount} currency={invoice.currencyCode} />
                      </td>
                      <td className="p-3 text-right text-body font-medium text-ink">
                        <Money amount={item.lineTotal} currency={invoice.currencyCode} />
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
                    <Money amount={invoice.subtotal} currency={invoice.currencyCode} />
                  </td>
                </tr>
                {Number(invoice.discountAmount) > 0 && (
                  <tr>
                    <td className="py-1 text-body text-ink-secondary">Discount</td>
                    <td className="py-1 text-right text-body text-ink">
                      −<Money amount={invoice.discountAmount} currency={invoice.currencyCode} />
                    </td>
                  </tr>
                )}
                <tr>
                  <td className="py-1 text-body text-ink-secondary">Tax</td>
                  <td className="py-1 text-right text-body text-ink">
                    <Money amount={invoice.taxAmount} currency={invoice.currencyCode} />
                  </td>
                </tr>
                <tr className="border-t border-border-strong">
                  <td className="pt-2 text-h4 text-ink">Total</td>
                  <td className="pt-2 text-right text-h4 text-ink">
                    <Money amount={invoice.totalAmount} currency={invoice.currencyCode} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* TICKET-033 — payment history against this invoice. */}
      <Card className="min-w-0 p-0">
        <h2 className="border-b border-border p-5 text-h4 text-ink">Payments</h2>
        {invoice.allocations.length === 0 ? (
          <p className="p-5 text-body text-ink-muted">No payments recorded against this invoice.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse">
              <caption className="sr-only">Payments applied to this invoice</caption>
              <thead>
                <tr className="border-b border-border bg-canvas">
                  <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                    Payment
                  </th>
                  <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                    Date
                  </th>
                  <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                    Method
                  </th>
                  <th scope="col" className="p-4 text-left text-body-sm font-semibold text-ink-secondary">
                    Reference
                  </th>
                  <th scope="col" className="p-4 text-right text-body-sm font-semibold text-ink-secondary">
                    Applied
                  </th>
                  <th scope="col" className="p-4">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoice.allocations.map((allocation) => (
                  <tr key={allocation.id} className="border-b border-border last:border-b-0">
                    <td className="p-4 text-body text-ink">
                      {allocation.payment.paymentNumber}
                      {allocation.payment.status === 'VOIDED' && (
                        <Badge tone="gray">Voided</Badge>
                      )}
                    </td>
                    <td className="p-4 text-body text-ink-secondary">
                      {formatDate(allocation.payment.paymentDate)}
                    </td>
                    <td className="p-4 text-body text-ink-secondary">
                      {paymentMethodLabel(allocation.payment.paymentMethod)}
                    </td>
                    <td className="p-4 text-body text-ink-secondary">
                      {allocation.payment.reference ?? '—'}
                    </td>
                    <td className="p-4 text-right text-body font-medium text-ink">
                      <Money
                        amount={allocation.allocatedAmount}
                        currency={invoice.currencyCode}
                      />
                    </td>
                    <td className="p-4 text-right">
                      {canVoid && allocation.payment.status === 'RECORDED' && (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setVoidTarget({
                              id: allocation.payment.id,
                              number: allocation.payment.paymentNumber,
                            });
                            setReason('');
                            setReasonError(null);
                            setDialog('void');
                          }}
                        >
                          <Undo2 className="h-4 w-4" aria-hidden="true" />
                          Void
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {(invoice.notes || invoice.terms) && (
        <Card className="flex flex-col gap-4">
          {invoice.notes && (
            <div>
              <h2 className="text-caption font-semibold uppercase tracking-wide text-ink-muted">
                Notes
              </h2>
              <p className="mt-1 whitespace-pre-wrap text-body text-ink">{invoice.notes}</p>
            </div>
          )}
          {invoice.terms && (
            <div>
              <h2 className="text-caption font-semibold uppercase tracking-wide text-ink-muted">
                Terms
              </h2>
              <p className="mt-1 whitespace-pre-wrap text-body text-ink">{invoice.terms}</p>
            </div>
          )}
        </Card>
      )}

      <RecordPaymentDialog
        open={payOpen}
        onClose={() => setPayOpen(false)}
        invoiceId={invoice.id}
        invoiceNumber={invoice.invoiceNumber}
        amountDue={invoice.amountDue}
        currency={invoice.currencyCode}
        onRecorded={({ replayed }) => {
          void queryClient.invalidateQueries({ queryKey: ['invoices'] });
          void queryClient.invalidateQueries({ queryKey: ['payments'] });
          if (replayed) {
            setActionError('That payment had already been recorded.');
          }
        }}
      />

      <Modal
        open={dialog === 'void'}
        onClose={() => {
          setDialog(null);
          setVoidTarget(null);
          setReasonError(null);
        }}
        title={`Void ${voidTarget?.number ?? 'payment'}?`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDialog(null);
                setVoidTarget(null);
                setReasonError(null);
              }}
              disabled={working}
            >
              Keep it
            </Button>
            <Button
              variant="destructive"
              loading={working}
              onClick={() => {
                if (!reason.trim()) {
                  setReasonError('A reason is required to void a payment');
                  return;
                }
                setReasonError(null);
                const target = voidTarget;
                if (!target) return;
                void run(
                  () => voidPayment(target.id, reason),
                  () => setVoidTarget(null),
                );
              }}
            >
              Void payment
            </Button>
          </>
        }
      >
        <p>
          The payment will be marked as voided and this invoice&apos;s balance recalculated. The
          payment record is kept for audit — payments are never deleted.
        </p>
        <div className="mt-4">
          <label htmlFor="void-reason" className="text-body-sm font-medium text-ink">
            Reason <span className="text-danger">*</span>
          </label>
          <Input
            id="void-reason"
            value={reason}
            invalid={Boolean(reasonError)}
            onChange={(e) => setReason(e.target.value)}
            className="mt-2"
          />
          {reasonError && (
            <p role="alert" className="mt-1 text-caption text-danger">
              {reasonError}
            </p>
          )}
        </div>
      </Modal>

      <Modal
        open={dialog === 'send'}
        onClose={() => setDialog(null)}
        title="Send this invoice?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)} disabled={working}>
              Cancel
            </Button>
            <Button loading={working} onClick={() => run(() => sendInvoice(id))}>
              Send invoice
            </Button>
          </>
        }
      >
        <p>
          {invoice.invoiceNumber} will be marked as sent and its PDF generated. Once sent, the
          invoice can no longer be edited.
        </p>
      </Modal>

      <Modal
        open={dialog === 'cancel'}
        onClose={() => {
          setDialog(null);
          setReasonError(null);
        }}
        title="Cancel this invoice?"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setDialog(null);
                setReasonError(null);
              }}
              disabled={working}
            >
              Keep it
            </Button>
            <Button
              variant="destructive"
              loading={working}
              onClick={() => {
                if (!reason.trim()) {
                  setReasonError('A reason is required to cancel an invoice');
                  return;
                }
                setReasonError(null);
                void run(() => cancelInvoice(id, reason));
              }}
            >
              Cancel invoice
            </Button>
          </>
        }
      >
        <p>
          {invoice.invoiceNumber} will be cancelled and its balance cleared. It stays in your
          records with its number intact — invoices are never deleted.
        </p>
        <div className="mt-4">
          <label htmlFor="cancel-reason" className="text-body-sm font-medium text-ink">
            Reason <span className="text-danger">*</span>
          </label>
          <Input
            id="cancel-reason"
            value={reason}
            invalid={Boolean(reasonError)}
            onChange={(e) => setReason(e.target.value)}
            className="mt-2"
          />
          {reasonError && (
            <p role="alert" className="mt-1 text-caption text-danger">
              {reasonError}
            </p>
          )}
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
