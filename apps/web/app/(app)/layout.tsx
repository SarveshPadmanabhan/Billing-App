'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { CurrentUserResponse } from '@billing/types';
import { apiFetch, ApiRequestError } from '../../lib/api-client';
import { authClient } from '../../lib/auth-client';
import { Sidebar } from '../../components/layout/sidebar';
import { Topbar } from '../../components/layout/topbar';

/**
 * Authenticated application shell (TICKET-008).
 *
 * Loads the current user from the API. The API — not this component — decides
 * what the user may see; a 401 here just means "go to /login".
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiFetch<CurrentUserResponse>('/auth/me'),
  });

  // Redirects belong in an effect. Calling router.push() during render mutates
  // the router while React is rendering this component, which React warns
  // about and which can drop the navigation.
  const unauthenticated = error instanceof ApiRequestError && error.status === 401;
  const needsOnboarding = Boolean(data) && !data?.organisation;

  useEffect(() => {
    if (unauthenticated) {
      // Clear the cookie before redirecting. The middleware only checks that a
      // session cookie EXISTS, never that it is valid — so a stale one (after a
      // database reset, or an expired session) sends /login straight back to
      // /dashboard, which 401s again. That loop renders nothing at all, which
      // is the blank page this guards against.
      void authClient
        .signOut()
        .catch(() => {
          // Signing out server-side is best-effort: the session may already be
          // gone. Removing the cookie locally is what breaks the loop.
          document.cookie =
            'better-auth.session_token=; Max-Age=0; path=/; SameSite=Lax';
        })
        .finally(() => router.replace('/login'));
    } else if (needsOnboarding) {
      router.replace('/onboarding');
    }
  }, [unauthenticated, needsOnboarding, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas">
        <p className="text-body text-ink-muted" role="status">
          Loading…
        </p>
      </div>
    );
  }

  if (error) {
    // The effect above signs out and redirects. Show something meanwhile —
    // returning null here is what made a failed redirect look like a broken
    // app rather than a session that had expired.
    if (unauthenticated) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-canvas">
          <p className="text-body text-ink-muted" role="status">
            Session expired — taking you to sign in…
          </p>
        </div>
      );
    }
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas px-4">
        <p className="text-body text-ink">Something went wrong.</p>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="h-10 rounded-sm bg-primary px-4 text-body font-medium text-white hover:bg-primary-hover"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!data) return null;

  // A user with no organisation must finish onboarding before using the app.
  // The effect above performs the navigation.
  if (!data.organisation) return null;

  return (
    <div className="flex min-h-screen bg-canvas">
      {/* Desktop sidebar. `hidden` removes it from the accessibility tree
          below lg, so it cannot collide with the drawer's landmark. */}
      <aside className="hidden lg:block">
        <div className="fixed inset-y-0 left-0 w-[248px]">
          <Sidebar />
        </div>
      </aside>

      {/* Mobile drawer (Spec §14) */}
      {navOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-ink/40"
            onClick={() => setNavOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-y-0 left-0">
            <div className="relative h-full">
              <Sidebar label="Mobile navigation" onNavigate={() => setNavOpen(false)} />
              <button
                type="button"
                onClick={() => setNavOpen(false)}
                aria-label="Close navigation menu"
                className="absolute right-[-44px] top-4 flex h-10 w-10 items-center justify-center rounded-sm bg-surface text-ink-secondary"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-[248px]">
        <Topbar user={data} onOpenNav={() => setNavOpen(true)} />
        <main className="mx-auto w-full max-w-content flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
