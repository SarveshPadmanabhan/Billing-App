'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  FileText,
  Receipt,
  CreditCard,
  BarChart3,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { clsx } from 'clsx';

/**
 * Primary navigation (Frontend Spec §7, TICKET-008).
 * 240–260px sidebar; the seven MVP modules in the specified order.
 */

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Customers', href: '/customers', icon: Users },
  { label: 'Quotations', href: '/quotations', icon: FileText },
  { label: 'Invoices', href: '/invoices', icon: Receipt },
  { label: 'Payments', href: '/payments', icon: CreditCard },
  { label: 'Reports', href: '/reports', icon: BarChart3 },
  { label: 'Settings', href: '/settings', icon: Settings },
];

export function Sidebar({
  onNavigate,
  /**
   * Distinguishes the two instances. The desktop sidebar and the mobile drawer
   * both render this component, and when the drawer is open both are in the
   * DOM — a single shared aria-label would announce two identical
   * "Main navigation" landmarks to a screen reader.
   */
  label = 'Main navigation',
}: {
  onNavigate?: () => void;
  label?: string;
}) {
  const pathname = usePathname() ?? '';

  return (
    <nav aria-label={label} className="flex h-full w-[248px] flex-col border-r border-border bg-surface">
      <div className="flex h-16 items-center gap-2 border-b border-border px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-primary text-surface">
          <Receipt className="h-5 w-5" aria-hidden="true" />
        </div>
        <span className="text-h4 text-ink">BillingApp</span>
      </div>

      <ul className="flex flex-1 flex-col gap-1 p-3">
        {NAV_ITEMS.map((item) => {
          // Exact match or a nested route (/customers/123 keeps Customers active).
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                // aria-current conveys the active page to screen readers —
                // colour alone must never carry meaning (Spec §15).
                aria-current={isActive ? 'page' : undefined}
                className={clsx(
                  'flex items-center gap-3 rounded-sm px-3 py-2 text-body transition-colors',
                  'min-h-[40px]',
                  isActive
                    ? 'bg-primary-light font-medium text-primary'
                    : 'text-ink-secondary hover:bg-canvas hover:text-ink',
                )}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
