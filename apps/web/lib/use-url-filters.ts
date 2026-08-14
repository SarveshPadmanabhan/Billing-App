'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import type { DocumentFilterValues } from '../components/documents/document-filters';
import { emptyFilters } from '../components/documents/document-filters';

/**
 * Keeps list filters in the URL (TICKET-037).
 *
 * Two reasons this matters beyond convenience:
 *   - A filtered view can be shared or bookmarked, and reloading keeps it.
 *     Losing a filter silently on refresh risks someone acting on a wider set
 *     of records than they believe they are looking at.
 *   - Back and forward behave as expected instead of dropping the user on an
 *     unfiltered list.
 *
 * The search box is debounced before it reaches the URL, so typing does not
 * write one entry per keystroke.
 */
export type FilterState = DocumentFilterValues & Record<string, string>;

export function useUrlFilters(extraKeys: readonly string[] = []) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Read once on mount. The URL is thereafter driven by state, not the other
  // way round; re-reading on every render would fight the writes below.
  const initial = useRef<FilterState>({
    search: searchParams?.get('search') ?? '',
    status: searchParams?.get('status') ?? '',
    customerId: searchParams?.get('customerId') ?? '',
    dateFrom: searchParams?.get('dateFrom') ?? '',
    dateTo: searchParams?.get('dateTo') ?? '',
    ...Object.fromEntries(extraKeys.map((key) => [key, searchParams?.get(key) ?? ''])),
  });

  const [filters, setFilters] = useState<FilterState>(initial.current);
  const [page, setPage] = useState(() => Number(searchParams?.get('page') ?? 1) || 1);

  // Debounced mirror of the search box; every other filter applies at once.
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(filters.search), 250);
    return () => clearTimeout(timer);
  }, [filters.search]);

  // Mirror state into the URL. `replace` rather than `push` so filtering does
  // not bury the previous page under a stack of history entries.
  useEffect(() => {
    const params = new URLSearchParams();
    const effective: Record<string, string> = { ...filters, search: debouncedSearch };

    for (const [key, value] of Object.entries(effective)) {
      if (value) params.set(key, value);
    }
    if (page > 1) params.set('page', String(page));

    const next = params.toString();
    if (next !== (searchParams?.toString() ?? '')) {
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
    }
  }, [filters, debouncedSearch, page, pathname, router, searchParams]);

  /** Changing any filter returns to page 1 — page 4 of a new result set is meaningless. */
  const update = useCallback((next: FilterState) => {
    setFilters(next);
    setPage(1);
  }, []);

  const clear = useCallback(() => {
    setFilters({
      ...emptyFilters,
      ...Object.fromEntries(extraKeys.map((key) => [key, ''])),
    });
    setPage(1);
  }, [extraKeys]);

  return {
    filters,
    /** Filters carrying the debounced search value — use this for the query. */
    applied: { ...filters, search: debouncedSearch } as FilterState,
    setFilters: update,
    clear,
    page,
    setPage,
  };
}
