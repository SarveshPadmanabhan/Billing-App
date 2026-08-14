'use client';

import { clsx } from 'clsx';
import { forwardRef } from 'react';

/**
 * Shared UI primitives (Frontend Spec §8–§10, §35).
 *
 * Deliberately small and dependency-free rather than pulling in all of
 * shadcn/ui: these cover what EPIC 2 needs, follow the design tokens exactly,
 * and can be swapped for shadcn components later without changing call sites.
 */

// --- Button ------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-hover disabled:bg-ink-disabled',
  secondary:
    'bg-surface text-[#334155] border border-border-strong hover:bg-canvas disabled:text-ink-disabled',
  destructive: 'bg-danger text-white hover:bg-[#B91C1C] disabled:bg-ink-disabled',
  ghost: 'bg-transparent text-ink-secondary hover:bg-canvas disabled:text-ink-disabled',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', loading = false, disabled, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // Loading implies disabled: prevents the duplicate submission that
      // Frontend Spec §8 requires we guard against.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex h-10 items-center justify-center gap-2 rounded-sm px-4 text-body font-medium',
        'transition-colors disabled:cursor-not-allowed',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
});

// --- Field / Input -----------------------------------------------------------

export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {/* Always a visible label — never placeholder-only (Spec §9). */}
      <label htmlFor={htmlFor} className="text-body-sm font-medium text-ink">
        {label}
        {required && (
          <span className="text-danger" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && (
        <p id={`${htmlFor}-hint`} className="text-caption text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${htmlFor}-error`} role="alert" className="text-caption text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ invalid, className, ...props }, ref) {
    return (
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className={clsx(
          'h-10 w-full rounded-sm border px-3 text-body text-ink outline-none',
          'focus:ring-2 focus:ring-primary-light',
          invalid ? 'border-danger focus:border-danger' : 'border-border-strong focus:border-primary',
          className,
        )}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={clsx(
        'w-full rounded-sm border border-border-strong p-3 text-body text-ink outline-none',
        'focus:border-primary focus:ring-2 focus:ring-primary-light',
        className,
      )}
      {...props}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={clsx(
          'h-10 w-full rounded-sm border border-border-strong bg-surface px-3 text-body text-ink outline-none',
          'focus:border-primary focus:ring-2 focus:ring-primary-light',
          className,
        )}
        {...props}
      >
        {children}
      </select>
    );
  },
);

// --- Card --------------------------------------------------------------------

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    // min-w-0 is load-bearing: a grid or flex child defaults to min-width:auto,
    // so wide content (a table, a long number) forces the card past the
    // viewport instead of letting its inner container scroll.
    <div className={clsx('min-w-0 rounded-md border border-border bg-surface p-5 shadow-card', className)}>
      {children}
    </div>
  );
}

// --- Badge -------------------------------------------------------------------

export type BadgeTone = 'gray' | 'blue' | 'green' | 'red' | 'orange';

const BADGE_TONES: Record<BadgeTone, string> = {
  gray: 'bg-canvas text-ink-secondary border-border-strong',
  blue: 'bg-primary-light text-primary border-primary/20',
  green: 'bg-success-light text-success border-success/20',
  red: 'bg-danger-light text-danger border-danger/20',
  orange: 'bg-warning-light text-warning border-warning/20',
};

export function Badge({ tone = 'gray', children }: { tone?: BadgeTone; children: React.ReactNode }) {
  return (
    // Text always carries the meaning — colour never alone (Spec §10, §15).
    <span
      className={clsx(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-caption font-medium',
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

// --- States ------------------------------------------------------------------

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-border bg-surface p-12 text-center shadow-card">
      <h2 className="text-h4 text-ink">{title}</h2>
      <p className="max-w-md text-body text-ink-muted">{description}</p>
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-md border border-border bg-surface p-12 text-center shadow-card"
    >
      <h2 className="text-h4 text-ink">Something went wrong</h2>
      <p className="max-w-md text-body text-ink-muted">{message ?? 'Please try again.'}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function PermissionDenied() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-border bg-surface p-12 text-center shadow-card">
      <h2 className="text-h4 text-ink">You don&apos;t have permission to view this page</h2>
      <p className="text-body text-ink-muted">Contact an administrator if you need access.</p>
    </div>
  );
}

export function TableSkeleton({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-surface shadow-card" aria-busy="true">
      <div className="sr-only" role="status">
        Loading…
      </div>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-4 border-b border-border p-4 last:border-b-0">
          {Array.from({ length: columns }).map((_, colIndex) => (
            <div key={colIndex} className="h-4 flex-1 animate-pulse rounded bg-canvas" />
          ))}
        </div>
      ))}
    </div>
  );
}

// --- Modal -------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-md rounded-lg bg-surface p-6 shadow-modal">
        <h2 className="text-h3 text-ink">{title}</h2>
        <div className="mt-3 text-body text-ink-secondary">{children}</div>
        {footer && <div className="mt-6 flex justify-end gap-3">{footer}</div>}
      </div>
    </div>
  );
}

// --- Money -------------------------------------------------------------------

/**
 * Renders a money string.
 *
 * Takes a string, never a number: the API sends decimal strings precisely so
 * no float conversion happens client-side. This formats for display only and
 * performs no arithmetic (Frontend Spec §37).
 */
export function Money({
  amount,
  currency = 'INR',
  className,
}: {
  amount: string;
  currency?: string;
  className?: string;
}) {
  const [whole, fraction = '00'] = amount.split('.');
  const grouped = Number(whole).toLocaleString('en-IN');

  return (
    <span className={clsx('tabular whitespace-nowrap', className)}>
      {currency} {grouped}.{fraction.slice(0, 2)}
    </span>
  );
}
