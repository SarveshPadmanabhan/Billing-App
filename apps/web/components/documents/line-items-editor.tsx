'use client';

import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Trash2, Plus, Package } from 'lucide-react';
import { Button, Input, Money } from '../ui/primitives';
import { apiFetch } from '../../lib/api-client';
import { emptyLineItem, type LineItemDraft } from '../../lib/quotations';

interface StockOption {
  id: string;
  sku: string;
  name: string;
  unit: string;
  unitPrice: string;
  quantityOnHand: string;
  tracksStock: boolean;
}

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
  const taxRate = Number(item.taxRate) || 0;

  // Per-line discount was removed from the editor, so a new line never carries
  // one. Documents created before that keep theirs, and the server still
  // honours the stored value — this preview only describes what is on screen.
  const net = quantity * unitPrice;
  const tax = (net * taxRate) / 100;

  return { gross: net, discount: 0, net, tax, total: net + tax };
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
      {/* The editor is wide by nature (6 columns). It scrolls inside this
          container rather than pushing the page sideways — Frontend Spec §14
          allows controlled horizontal scrolling for tables. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse">
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
              <th scope="col" className="w-32 pb-2 text-right text-caption font-semibold text-ink-secondary">
                Rate <span className="text-danger">*</span>
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
                    <ProductPicker
                      index={index}
                      item={item}
                      disabled={disabled}
                      invalid={Boolean(fieldError('description'))}
                      onPick={(product) =>
                        update(index, {
                          stockItemId: product.id,
                          description: product.name,
                          unit: product.unit,
                          unitPrice: product.unitPrice.replace(/\.?0+$/, ''),
                        })
                      }
                      onType={(value) =>
                        // Typing over a picked product breaks the link: the line
                        // is no longer that product, so it must not deduct it.
                        update(index, { description: value, stockItemId: null })
                      }
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


/**
 * Description field with a product suggestion menu.
 *
 * Picking a product fills the description, unit and rate, and records the
 * stock link so the invoice deducts stock when it is sent. Free text is still
 * allowed — services and ad-hoc charges have no product and deduct nothing.
 *
 * Typing over a picked product clears the link. Leaving it attached would mean
 * a line describing one thing while deducting another.
 *
 * The menu renders through a portal rather than inline. The table sits in an
 * overflow-x-auto container so wide content scrolls instead of pushing the
 * page sideways, and that container clips vertically too — an absolutely
 * positioned menu was cut off at its edge. z-index cannot fix that; clipping
 * happens before stacking. A portal takes the menu out of the container
 * entirely, so it is positioned against the viewport and flips above the
 * input when there is not enough room below.
 */
function ProductPicker({
  index,
  item,
  disabled,
  invalid,
  onPick,
  onType,
}: {
  index: number;
  item: LineItemDraft;
  disabled: boolean;
  invalid: boolean;
  onPick: (product: StockOption) => void;
  onType: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  } | null>(null);

  const { data } = useQuery({
    queryKey: ['stock', 'options'],
    queryFn: () => apiFetch<{ items: StockOption[] }>('/stock?limit=100'),
    // The list is small and reused by every line; refetching per keystroke
    // would be a request per character for no benefit.
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!open) return;
    function onDocumentClick(event: MouseEvent) {
      const target = event.target as Node;
      // The menu is portalled outside the container, so it needs its own
      // hit test — otherwise clicking an option counts as an outside click
      // and closes the menu before the option fires.
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [open]);

  // Measure against the viewport and decide whether the menu opens downward
  // or flips above. useLayoutEffect so the position is set before paint —
  // with useEffect the menu would appear at 0,0 for one frame.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    function place() {
      const input = containerRef.current?.querySelector('input');
      if (!input) return;
      const rect = input.getBoundingClientRect();
      const MENU_MAX = 256; // matches max-h-64
      const GAP = 4;
      const spaceBelow = window.innerHeight - rect.bottom;

      // Flip up only when below genuinely cannot fit AND above has more room,
      // so a menu near the top of a short window does not flip into nothing.
      const flipUp = spaceBelow < MENU_MAX + GAP && rect.top > spaceBelow;

      setPosition({
        left: rect.left,
        width: rect.width,
        ...(flipUp
          ? { bottom: window.innerHeight - rect.top + GAP }
          : { top: rect.bottom + GAP }),
      });
    }

    place();
    // The input moves when the page or its container scrolls; capture catches
    // scrolls on the table container as well as the window.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  const term = item.description.trim().toLowerCase();
  // Suggestions appear only once something is typed. An empty field lists
  // nothing: the menu would otherwise cover the row the moment the field takes
  // focus, including when tabbing through the form.
  const matches = !term
    ? []
    : (data?.items ?? [])
        .filter(
          (p) => p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term),
        )
        .slice(0, 8);

  return (
    <div ref={containerRef} className="relative">
      <Input
        aria-label={`Description for line ${index + 1}`}
        value={item.description}
        disabled={disabled}
        invalid={invalid}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls={`product-options-${index}`}
        onChange={(e) => {
          onType(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Search a product, or type anything"
      />

      {item.stockItemId && (
        <span className="mt-1 inline-flex items-center gap-1 text-caption text-ink-muted">
          <Package className="h-3 w-3" aria-hidden="true" />
          Linked to stock — this line will be deducted
        </span>
      )}

      {open &&
        matches.length > 0 &&
        position &&
        typeof document !== 'undefined' &&
        createPortal(
          <ul
            ref={menuRef}
            id={`product-options-${index}`}
            role="listbox"
            style={{
              left: position.left,
              width: Math.max(position.width, 280),
              ...(position.top !== undefined ? { top: position.top } : {}),
              ...(position.bottom !== undefined ? { bottom: position.bottom } : {}),
            }}
            className="fixed z-50 max-h-64 overflow-auto rounded-md border border-border bg-surface py-1 shadow-modal"
          >
            {matches.map((product) => (
              <li key={product.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={product.id === item.stockItemId}
                  onClick={() => {
                    onPick(product);
                    setOpen(false);
                  }}
                  className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left hover:bg-canvas"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-body text-ink">{product.name}</span>
                    <span className="block truncate text-caption text-ink-muted">{product.sku}</span>
                  </span>
                  <span className="shrink-0 text-caption text-ink-muted">
                    {product.tracksStock
                      ? `${product.quantityOnHand.replace(/\.?0+$/, '')} ${product.unit}`
                      : 'Not tracked'}
                  </span>
                </button>
              </li>
            ))}
          </ul>,
          document.body,
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
