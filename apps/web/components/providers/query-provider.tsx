'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiRequestError } from '../../lib/api-client';

/**
 * TanStack Query setup (Frontend Spec §32).
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: (failureCount, error) => {
              // Never retry auth/permission failures — retrying a 401 or 403
              // cannot succeed and just delays the redirect.
              if (error instanceof ApiRequestError && error.status < 500) return false;
              return failureCount < 2;
            },
            refetchOnWindowFocus: false,
          },
          mutations: {
            // Financial mutations are never retried automatically: a retry
            // could duplicate a payment (Frontend Spec §32).
            retry: false,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
