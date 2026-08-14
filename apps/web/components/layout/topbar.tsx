'use client';

import { useState } from 'react';
import { Menu, Bell, ChevronDown, Plus, LogOut } from 'lucide-react';
import { clsx } from 'clsx';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { CurrentUserResponse } from '@billing/types';
import { authClient } from '../../lib/auth-client';
import { GlobalSearch } from './global-search';

/**
 * Top bar (Frontend Spec §7): notifications, organisation switcher, avatar
 * menu, plus the global Create action required by TICKET-008.
 */
export function Topbar({
  user,
  onOpenNav,
}: {
  user: CurrentUserResponse;
  onOpenNav: () => void;
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  const initials = `${user.user.firstName.charAt(0)}${user.user.lastName?.charAt(0) ?? ''}`.toUpperCase();

  async function signOut() {
    await authClient.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <header className="flex h-16 items-center justify-between gap-4 border-b border-border bg-surface px-4 lg:px-6">
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation menu"
        className="flex h-10 w-10 items-center justify-center rounded-sm text-ink-secondary hover:bg-canvas lg:hidden"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {user.organisation && (
            <span className="truncate text-body font-medium text-ink">
              {user.organisation.organisationName}
            </span>
          )}
          {user.organisation && (
            <span className="hidden rounded-full bg-canvas px-2 py-0.5 text-caption text-ink-secondary lg:inline">
              {user.organisation.role}
            </span>
          )}
        </div>
        <GlobalSearch />
      </div>

      <div className="flex items-center gap-2">
        {/* Global create (TICKET-008) */}
        <div className="relative">
          <button
            type="button"
            onClick={() => { setCreateOpen((v) => !v); setAccountOpen(false); }}
            aria-expanded={createOpen}
            aria-haspopup="menu"
            className="flex h-10 items-center gap-2 rounded-sm bg-primary px-4 text-body font-medium text-white transition-colors hover:bg-primary-hover"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Create</span>
          </button>

          {createOpen && (
            <div
              role="menu"
              className="absolute right-0 z-20 mt-2 w-56 rounded-md border border-border bg-surface py-1 shadow-modal"
            >
              {[
                { label: 'New Invoice', href: '/invoices/new' },
                { label: 'New Quotation', href: '/quotations/new' },
                { label: 'New Customer', href: '/customers/new' },
              ].map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  role="menuitem"
                  onClick={() => setCreateOpen(false)}
                  className="block px-4 py-2 text-body text-ink-secondary hover:bg-canvas hover:text-ink"
                >
                  {item.label}
                </Link>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          aria-label="Notifications"
          className="flex h-10 w-10 items-center justify-center rounded-sm text-ink-secondary hover:bg-canvas"
        >
          <Bell className="h-5 w-5" aria-hidden="true" />
        </button>

        <div className="relative">
          <button
            type="button"
            onClick={() => { setAccountOpen((v) => !v); setCreateOpen(false); }}
            aria-expanded={accountOpen}
            aria-haspopup="menu"
            aria-label="Account menu"
            className="flex h-10 items-center gap-2 rounded-sm px-2 hover:bg-canvas"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-light text-caption font-semibold text-primary">
              {initials || '?'}
            </span>
            <ChevronDown className="hidden h-4 w-4 text-ink-muted sm:block" aria-hidden="true" />
          </button>

          {accountOpen && (
            <div
              role="menu"
              className="absolute right-0 z-20 mt-2 w-64 rounded-md border border-border bg-surface py-1 shadow-modal"
            >
              <div className="border-b border-border px-4 py-3">
                <p className="truncate text-body font-medium text-ink">
                  {user.user.firstName} {user.user.lastName ?? ''}
                </p>
                <p className="truncate text-body-sm text-ink-muted">{user.user.email}</p>
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={signOut}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-body text-ink-secondary hover:bg-canvas hover:text-ink"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
