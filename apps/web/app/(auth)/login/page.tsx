'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { authClient } from '../../../lib/auth-client';

/**
 * useSearchParams() opts a component out of static rendering, so Next requires
 * a Suspense boundary around it: without one the whole page bails out of
 * prerendering and the production build fails. The form is wrapped below and
 * the page shell stays static.
 */
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return; // Prevent duplicate submission (Spec §8).

    setSubmitting(true);
    setError(null);

    const { error: signInError } = await authClient.signIn.email({ email, password });

    if (signInError) {
      // Deliberately generic: never reveal whether the email exists
      // (Security Doc §23).
      setError('Email or password is incorrect.');
      setSubmitting(false);
      return;
    }

    // Only accept a same-site relative path — an absolute URL here would be an
    // open-redirect into a phishing page carrying a freshly issued session.
    const requested = params?.get('next');
    const destination =
      requested && requested.startsWith('/') && !requested.startsWith('//')
        ? requested
        : '/dashboard';

    router.push(destination);
    router.refresh();
  }

  return (
    <>
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4" noValidate>
          {error && (
            <div role="alert" className="rounded-sm bg-danger-light p-3 text-body-sm text-danger">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <label htmlFor="email" className="text-body-sm font-medium text-ink">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-10 rounded-sm border border-border-strong px-3 text-body outline-none focus:border-primary focus:ring-2 focus:ring-primary-light"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="password" className="text-body-sm font-medium text-ink">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-10 rounded-sm border border-border-strong px-3 text-body outline-none focus:border-primary focus:ring-2 focus:ring-primary-light"
            />
          </div>

        <button
          type="submit"
          disabled={submitting}
          className="h-10 rounded-sm bg-primary px-4 text-body font-medium text-white transition-colors hover:bg-primary-hover disabled:bg-ink-disabled"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-4 text-body-sm text-ink-muted">
        No account?{' '}
        <Link href="/register" className="text-primary hover:underline">
          Create one
        </Link>
      </p>
    </>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-[400px] rounded-md border border-border bg-surface p-6 shadow-card">
        <h1 className="text-h2 text-ink">Sign in</h1>
        <p className="mt-1 text-body text-ink-muted">Access your billing workspace.</p>
        <Suspense
          fallback={<p className="mt-6 text-body text-ink-muted">Loading…</p>}
        >
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
