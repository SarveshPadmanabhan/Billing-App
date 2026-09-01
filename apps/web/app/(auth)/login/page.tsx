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
    <main className="relative flex min-h-screen items-center justify-end px-4 sm:px-12 lg:px-16">
      {/*
        Full-bleed background. Plain <img> rather than next/image: this is a
        single decorative image with no layout to shift, and it must cover the
        viewport at any aspect ratio, which object-cover does directly.

        aria-hidden and empty alt — it carries no information a screen reader
        needs, and announcing it would only delay reaching the form.

        The gradient below it is a fallback, not decoration: if the file is
        ever missing the card still lands on a solid surface instead of white
        text on white.
      */}
      <div aria-hidden="true" className="absolute inset-0 z-0 overflow-hidden bg-gradient-to-br from-[#1E293B] via-[#334155] to-[#0F172A]">
        <img
          src="/login-background.20e17dab.jpg"
          alt=""
          className="h-full w-full object-cover"
        />
        {/*
          Scrim. The card is opaque, but on a busy photograph a hard-edged
          white panel reads as pasted on; this darkens the image enough to sit
          it in the scene, and guarantees contrast if the image is ever
          replaced with a lighter one.
        */}
        <div className="absolute inset-0 bg-ink/30" />
      </div>

      <div className="relative z-10 w-full max-w-[400px] rounded-lg border border-white/10 bg-surface p-6 shadow-modal">
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
