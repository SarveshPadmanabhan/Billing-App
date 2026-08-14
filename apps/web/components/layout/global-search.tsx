'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Search, FileText, Receipt, Users } from 'lucide-react';
import { apiFetch } from '../../lib/api-client';
import { Badge, Money, type BadgeTone } from '../ui/primitives';

/**
 * Global search (TICKET-036).
 *
 * One input that reaches invoices, quotations and customers, so "where is
 * INV-000042?" does not require choosing a module first. The API decides what
 * each role may see, so results are already permission-filtered.
 */

interface SearchResult {
  type: 'customer' | 'quotation' | 'invoice';
  id: string;
  title: string;
  subtitle: string | null;
  status: string | null;
  amount: string | null;
  currencyCode: string | null;
  date: string | null;
  url: string;
}

interface SearchResponse {
  query: string;
  results: SearchResult[];
  counts: { customers: number; quotations: number; invoices: number };
  truncated: boolean;
}

const TYPE_ICON = { invoice: Receipt, quotation: FileText, customer: Users } as const;

const STATUS_TONE: Record<string, BadgeTone> = {
  DRAFT: 'gray',
  SENT: 'blue',
  ACCEPTED: 'green',
  CONVERTED: 'green',
  PAID: 'green',
  PARTIALLY_PAID: 'blue',
  OVERDUE: 'red',
  REJECTED: 'red',
  EXPIRED: 'orange',
  CANCELLED: 'gray',
  ARCHIVED: 'gray',
};

const humanStatus = (s: string) =>
  s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

export function GlobalSearch() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);

  // Close when focus or a click leaves the component.
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => apiFetch<SearchResponse>(`/search?q=${encodeURIComponent(debounced)}`),
    // Two characters is the shortest query worth a round trip.
    enabled: debounced.length >= 2,
    staleTime: 15_000,
  });

  const results = data?.results ?? [];

  function go(result: SearchResult) {
    setOpen(false);
    setQuery('');
    router.push(result.url);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (results.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((i) => (i + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = results[highlighted];
      if (target) go(target);
    }
  }

  const showPanel = open && debounced.length >= 2;

  return (
    <div ref={containerRef} className="relative hidden w-full max-w-md md:block">
      <label htmlFor="global-search" className="sr-only">
        Search invoices, quotations and customers
      </label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
          aria-hidden="true"
        />
        <input
          id="global-search"
          type="search"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls="global-search-results"
          aria-autocomplete="list"
          value={query}
          placeholder="Search invoices, quotations, customers"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHighlighted(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="h-10 w-full rounded-sm border border-border-strong bg-surface pl-9 pr-3 text-body text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary-light"
        />
      </div>

      {showPanel && (
        <div
          id="global-search-results"
          role="listbox"
          aria-label="Search results"
          className="absolute left-0 right-0 top-12 z-30 max-h-[420px] overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-modal"
        >
          {isFetching && results.length === 0 ? (
            <p className="px-4 py-3 text-body-sm text-ink-muted" role="status">
              Searching…
            </p>
          ) : results.length === 0 ? (
            <p className="px-4 py-3 text-body-sm text-ink-muted">
              Nothing matched “{debounced}”.
            </p>
          ) : (
            <>
              {results.map((result, index) => {
                const Icon = TYPE_ICON[result.type];
                return (
                  <button
                    key={`${result.type}-${result.id}`}
                    type="button"
                    role="option"
                    aria-selected={index === highlighted}
                    onMouseEnter={() => setHighlighted(index)}
                    onClick={() => go(result)}
                    className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
                      index === highlighted ? 'bg-canvas' : ''
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-medium text-ink">
                        {result.title}
                      </span>
                      {result.subtitle && (
                        <span className="block truncate text-caption text-ink-muted">
                          {result.subtitle}
                        </span>
                      )}
                    </span>
                    {result.status && (
                      <Badge tone={STATUS_TONE[result.status] ?? 'gray'}>
                        {humanStatus(result.status)}
                      </Badge>
                    )}
                    {result.amount && result.currencyCode && (
                      <span className="shrink-0 text-body-sm text-ink-secondary">
                        <Money amount={result.amount} currency={result.currencyCode} />
                      </span>
                    )}
                  </button>
                );
              })}

              {data?.truncated && (
                <p className="border-t border-border px-4 py-2 text-caption text-ink-muted">
                  Showing the closest matches. Use a module&apos;s filters to see everything.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
