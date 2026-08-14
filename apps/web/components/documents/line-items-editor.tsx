'use client';

import { Trash2, Plus } from 'lucide-react';
import { Button, Input, Money } from '../ui/primitives';
import { emptyLineItem, type LineItemDraft } from '../../lib/quotations';

/**
 * Line-item editor (Frontend Spec §12, TICKET-016).
 *
 * The per-line and running totals shown here are a PREVIEW only. The server
 * recomputes everything on submit and its figures are authoritative — the
 * response replaces whatever was displayed. This preview exists so a user can
 * see the effect of a change immediately; it must never be sent back or relied
 * on (Security Doc §16).
 *
 * The preview uses plain JS arithmetic, which is acceptable precisely because
 * it is never persisted. Any value that reaches the database goes through
 * decimal.js on the server.
 */

export interface LineItemsEditorProps {
  items: LineItemDraft[];
  onChange: (items: LineItemDraft[]) => void;
  currency: string;
  /** Field-level errors keyed as "items[0].quantity". */
  errors?: Record<string, string>;
  disabled?: boolean;
}

/** Preview arithmetic. Mirrors the server's order of operations. */
function previewLine(item: LineItemDraft) {
  const quantity = Number(item.quantity) || 0;
  const unitPrice = Number(item.unitPrice) || 0;
  const discountRate = Number(item.discountRate) || 0;
  const taxRate = Number(item.taxRate) || 0;

  const gross = quantity * unitPrice;
  const discount = (gross * discountRate) / 100;
  const net = gross - discount;
  const tax = (net * taxRate) / 100;

  return { gross, discount, net, tax, total: net + tax };
}

export function previewTotals(items: LineItemDraft[], documentDiscountRate: string) {
  const lines = items.map(previewLine);
  const subtotal = lines.reduce((sum, line) => sum + line.net, 0);
  const rate = Number(documentDiscountRate) || 0;
  const documentDiscount = (subtotal * rate) / 100;
  const taxableBase = subtotal - documentDiscount;

  // Tax is apportioned by the document discount, as the server does.
  const ratio = subtotal === 0 ? 0 : taxableBase / subtotal;
  const tax = lines.reduce((sum, line) => sum + line.tax * ratio, 0);

  return { subtotal, documentDiscount, tax, total: taxableBase + tax };
}

const money = (value: number) => value.toFixed(4);

export function LineItemsEditor({
  items,
  onChange,
  currency,
  errors = {},
  disabled = false,
}: LineItemsEditorProps) {
  function update(index: number, patch: Partial<LineItemDraft>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function remove(index: number) {
    // Always keep one row: an empty document is invalid server-side anyway,
    // and a table with no rows gives the user nothing to type into.
    if (items.length === 1) {
      onChange([emptyLineItem()]);
      return;
    }
    onChange(items.filter((_, i) => i !== index));
  }

  function add() {
    // Carry the tax rate from the last row — most documents use one rate
    // throughout, and retyping it per line is pure friction.
    const lastTaxRate = items[items.length - 1]?.taxRate ?? '';
    onChange([...items, { ...emptyLineItem(), taxRate: lastTaxRate }]);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* The editor is wide by nature (8 columns). It scrolls inside this
          container rather than pushing the page sideways — Frontend Spec §14
          allows controlled horizontal scrolling for tables. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse">
          <caption className="sr-only">Line items</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="w-8 pb-2 text-left text-caption font-semibold text-ink-secondary">
                #
              </th>
              <th scope="col" className="pb-2 text-left text-caption font-semibold text-ink-secondary">
                Description <span className="text-danger">*</span>
              </th>
              <th scope="col" className="w-24 pb-2 text-right text-caption font-semibold text-ink-secondary">
                Qty <span className="text-danger">*</span>
              </th>
              <th scope="col" className="w-24 pb-2 text-left text-caption font-semibold text-ink-secondary">
                Unit
              </th>
              <th scope="col" className="w-32 pb-2 text-right text-caption font-semibold text-ink-secondary">
                Rate <span className="text-danger">*</span>
              </th>
              <th scope="col" className="w-24 pb-2 text-right text-caption font-semibold text-ink-secondary">
                Disc %
              </th>
              <th scope="col" className="w-24 pb-2 text-right text-caption font-semibold text-ink-secondary">
                Tax %
              </th>
              <th scope="col" className="w-36 pb-2 text-right text-caption font-semibold text-ink-secondary">
                Line total
              </th>
              <th scope="col" className="w-10 pb-2">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => {
              const line = previewLine(item);
              const fieldError = (field: string) => errors[`items[${index}].${field}`];

              return (
                <tr key={item.key} className="border-b border-border last:border-b-0">
                  <td className="py-2 pr-2 text-body-sm text-ink-muted">{index + 1}</td>

                  <td className="py-2 pr-2">
                    <Input
                      aria-label={`Description for line ${index + 1}`}
                      value={item.description}
                      disabled={disabled}
                      invalid={Boolean(fieldError('description'))}
                      onChange={(e) => update(index, { description: e.target.value })}
                      placeholder="What are you charging for?"
                    />
                    {fieldError('description') && (
                      <p className="mt-1 text-caption text-danger">{fieldError('description')}</p>
                    )}
                  </td>

                  <td className="py-2 pr-2">
                    <Input
                      aria-label={`Quantity for line ${index + 1}`}
                      inputMode="decimal"
                      className="tabular text-right"
                      value={item.quantity}
                      disabled={disabled}
                      invalid={Boolean(fieldError('quantity'))}
                      onChange={(e) => update(index, { quantity: e.target.value })}
                    />
                    {fieldError('quantity') && (
                      <p className="mt-1 text-caption text-danger">{fieldError('quantity')}</p>
                    )}
                  </td>

                  <td className="py-2 pr-2">
                    <Input
                      aria-label={`Unit for line ${index + 1}`}
                      value={item.unit}
                      disabled={disabled}
                      onChange={(e) => update(index, { unit: e.target.value })}
                      placeholder="hrs"
                    />
                  </td>

                  <td className="py-2 pr-2">
                    <Input
                      aria-label={`Unit price for line ${index + 1}`}
                      inputMode="decimal"
                      className="tabular text-right"
                      value={item.unitPrice}
                      disabled={disabled}
                      invalid={Boolean(fieldError('unitPrice'))}
                      onChange={(e) => update(index, { unitPrice: e.target.value })}
                    />
                    {fieldError('unitPrice') && (
                      <p className="mt-1 text-caption text-danger">{fieldError('unitPrice')}</p>
                    )}
                  </td>

                  <td className="py-2 pr-2">
                    <Input
                      aria-label={`Discount percent for line ${index + 1}`}
                      inputMode="decimal"
                      className="tabular text-right"
                      value={item.discountRate}
                      disabled={disabled}
                      invalid={Boolean(fieldError('discountRate'))}
                      onChange={(e) => update(index, { discountRate: e.target.value })}
                      placeholder="0"
                    />
                  </td>

                  <td className="py-2 pr-2">
                    <Input
                      aria-label={`Tax percent for line ${index + 1}`}
                      inputMode="decimal"
                      className="tabular text-right"
                      value={item.taxRate}
                      disabled={disabled}
                      invalid={Boolean(fieldError('taxRate'))}
                      onChange={(e) => update(index, { taxRate: e.target.value })}
                      placeholder="0"
                    />
                  </td>

                  <td className="py-2 pr-2 text-right text-body text-ink">
                    <Money amount={money(line.total)} currency={currency} />
                  </td>

                  <td className="py-2">
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      disabled={disabled}
                      aria-label={`Remove line ${index + 1}`}
                      className="flex h-9 w-9 items-center justify-center rounded-sm text-ink-muted hover:bg-danger-light hover:text-danger disabled:opacity-40"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div>
        <Button type="button" variant="secondary" onClick={add} disabled={disabled}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add line
        </Button>
      </div>

      {errors.items && (
        <p role="alert" className="text-caption text-danger">
          {errors.items}
        </p>
      )}
    </div>
  );
}

/** Totals preview. Labelled as provisional so nobody mistakes it for stored data. */
export function TotalsSummary({
  items,
  documentDiscountRate,
  currency,
}: {
  items: LineItemDraft[];
  documentDiscountRate: string;
  currency: string;
}) {
  const totals = previewTotals(items, documentDiscountRate);

  return (
    <div className="flex justify-end">
      <table className="min-w-[280px]">
        <caption className="sr-only">Totals preview</caption>
        <tbody>
          <tr>
            <td className="py-1 text-body text-ink-secondary">Subtotal</td>
            <td className="py-1 text-right text-body text-ink">
              <Money amount={money(totals.subtotal)} currency={currency} />
            </td>
          </tr>
          {totals.documentDiscount > 0 && (
            <tr>
              <td className="py-1 text-body text-ink-secondary">Discount</td>
              <td className="py-1 text-right text-body text-ink">
                −<Money amount={money(totals.documentDiscount)} currency={currency} />
              </td>
            </tr>
          )}
          <tr>
            <td className="py-1 text-body text-ink-secondary">Tax</td>
            <td className="py-1 text-right text-body text-ink">
              <Money amount={money(totals.tax)} currency={currency} />
            </td>
          </tr>
          <tr className="border-t border-border-strong">
            <td className="pt-2 text-h4 text-ink">Total</td>
            <td className="pt-2 text-right text-h4 text-ink">
              <Money amount={money(totals.total)} currency={currency} />
            </td>
          </tr>
          <tr>
            <td colSpan={2} className="pt-2 text-caption text-ink-muted">
              Totals are confirmed by the server when you save.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
