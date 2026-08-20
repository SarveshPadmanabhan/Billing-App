'use client';

import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { Input } from '../ui/primitives';
import { customerName, type Customer } from '../../lib/customers';

/**
 * Searchable customer field.
 *
 * Replaces a native <select>, which on a long customer list meant scrolling a
 * dropdown with no way to type. Here the input filters by name, email or
 * phone, and a customer is only "chosen" by picking from the list — free text
 * is not a customer, so the selection is always a real record.
 *
 * The menu renders through a portal for the same reason as the product picker:
 * the surrounding card clips an absolutely positioned child, and z-index does
 * not help because clipping happens before stacking.
 */
export function CustomerPicker({
  id,
  customers,
  loading,
  value,
  invalid,
  onChange,
}: {
  id: string;
  customers: Customer[];
  loading: boolean;
  value: string;
  invalid: boolean;
  onChange: (customerId: string) => void;
}) {
  const selected = customers.find((c) => c.id === value) ?? null;

  // What is typed, as distinct from what is selected. Kept separate so typing
  // a filter does not look like it has changed the chosen customer.
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocumentClick(event: MouseEvent) {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
      setSearch('');
    }
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    function place() {
      const input = containerRef.current?.querySelector('input');
      if (!input) return;
      const rect = input.getBoundingClientRect();
      const MENU_MAX = 288;
      const GAP = 4;
      const spaceBelow = window.innerHeight - rect.bottom;
      const flipUp = spaceBelow < MENU_MAX + GAP && rect.top > spaceBelow;
      setPosition({
        left: rect.left,
        width: rect.width,
        ...(flipUp ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
      });
    }
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  const term = search.trim().toLowerCase();
  // Suggestions require a search term. An empty field lists nothing: the menu
  // would otherwise cover the fields below the moment this one takes focus,
  // including when tabbing through the form.
  const matches = !term
    ? []
    : customers.filter((c) => {
        const haystack = [customerName(c), c.email ?? '', c.phone ?? ''].join(' ').toLowerCase();
        return haystack.includes(term);
      });

  function choose(customer: Customer) {
    onChange(customer.id);
    setSearch('');
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <Input
        id={id}
        // While open the field shows what is being typed; when closed it shows
        // the chosen customer, so the field always reads as its current value.
        value={open ? search : selected ? customerName(selected) : ''}
        disabled={loading}
        invalid={invalid}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls={`${id}-options`}
        aria-autocomplete="list"
        placeholder={loading ? 'Loading customers…' : 'Search or select a customer'}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            setSearch('');
            return;
          }
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter') {
            // Only swallow Enter when it selects something; otherwise let the
            // form handle it normally.
            const pick = matches[highlight];
            if (pick) {
              e.preventDefault();
              choose(pick);
            }
          }
        }}
      />

      {/* Requires a term: without it an empty field would render an empty box. */}
      {open &&
        term.length > 0 &&
        position &&
        typeof document !== 'undefined' &&
        createPortal(
          <ul
            ref={menuRef}
            id={`${id}-options`}
            role="listbox"
            style={{
              left: position.left,
              width: Math.max(position.width, 260),
              ...(position.top !== undefined ? { top: position.top } : {}),
              ...(position.bottom !== undefined ? { bottom: position.bottom } : {}),
            }}
            className="fixed z-50 max-h-72 overflow-auto rounded-md border border-border bg-surface py-1 shadow-modal"
          >
            {matches.length === 0 ? (
              <li className="px-3 py-2 text-caption text-ink-muted">
                {customers.length === 0
                  ? 'No customers yet — add one before creating this document.'
                  : `No customer matches "${search.trim()}".`}
              </li>
            ) : (
              matches.map((customer, index) => (
                <li key={customer.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={customer.id === value}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => choose(customer)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left ${
                      index === highlight ? 'bg-canvas' : ''
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-ink">
                        {customerName(customer)}
                      </span>
                      {(customer.email || customer.phone) && (
                        <span className="block truncate text-caption text-ink-muted">
                          {customer.email || customer.phone}
                        </span>
                      )}
                    </span>
                    {customer.id === value && (
                      <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>,
          document.body,
        )}
    </div>
  );
}
