'use client';

import { useQuery } from '@tanstack/react-query';
import type { CurrentUserResponse, Permission } from '@billing/types';
import { apiFetch } from './api-client';
import { PermissionDenied } from '../components/ui/primitives';

/**
 * Permission gate for create/edit pages (TICKET-048).
 *
 * List pages already gate on view permissions, but the create and edit routes
 * are reachable by direct URL. Without this, a VIEWER could fill in an entire
 * invoice before the server rejected the POST with a 403 — the denial was
 * enforced, but only after the work was done.
 *
 * Reads the server-computed `permissions` array rather than re-deriving from
 * the role, so config-gated cases (SALES quotation:convert) stay correct in
 * one place instead of two.
 *
 * This is presentation only. The server is still the authority: every write
 * re-checks the permission independently (Security Doc §16), and this hook
 * must never be treated as the thing that keeps a write safe.
 *
 * Returns a node to render *instead of* the page when denied, or null to
 * proceed. While the session is still loading it returns null rather than a
 * denial, so an authorised user never sees a flash of "no permission".
 */
export function usePermissionGuard(permission: Permission): React.ReactNode | null {
  const { data: me } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<CurrentUserResponse>('/auth/me'),
  });

  const granted = me?.organisation?.permissions;
  if (!granted) return null;

  return granted.includes(permission) ? null : <PermissionDenied />;
}
