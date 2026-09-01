'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { authClient } from '../../../lib/auth-client';

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update(field: keyof typeof form) {
    return (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: event.target.value }));
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    if (form.password.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }

    setSubmitting(true);
    setError(null);

    const { error: signUpError } = await authClient.signUp.email({
      email: form.email,
      password: form.password,
      name: `${form.firstName} ${form.lastName}`.trim(),
      firstName: form.firstName,
      lastName: form.lastName || undefined,
    } as Parameters<typeof authClient.signUp.email>[0]);

    if (signUpError) {
      // A duplicate email is reported the same way as any other failure so the
      // form cannot be used to enumerate registered addresses.
      setError('We could not create that account. Please check your details and try again.');
      setSubmitting(false);
      return;
    }

    router.push('/onboarding');
    router.refresh();
  }

  return (
    <main className="relative flex min-h-screen items-center justify-end overflow-hidden px-4 py-8 sm:px-10">
      {/* Same treatment as sign-in: the two pages link to each other, so a
          different background on each reads as two different products. */}
      <div aria-hidden="true" className="absolute inset-0 z-0 bg-gradient-to-br from-[#1E293B] via-[#334155] to-[#0F172A]">
        <img src="/login-background.jpg" alt="" className="h-full w-full object-cover" />
        <div className="absolute inset-0 bg-ink/30" />
      </div>

      <div className="relative z-10 w-full max-w-[440px] rounded-lg border border-white/10 bg-surface p-6 shadow-modal">
        <h1 className="text-h2 text-ink">Create your account</h1>
        <p className="mt-1 text-body text-ink-muted">Start billing in a few minutes.</p>

        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4" noValidate>
          {error && (
            <div role="alert" className="rounded-sm bg-danger-light p-3 text-body-sm text-danger">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <label htmlFor="firstName" className="text-body-sm font-medium text-ink">
                First name
              </label>
              <input
                id="firstName"
                required
                value={form.firstName}
                onChange={update('firstName')}
                className="h-10 rounded-sm border border-border-strong px-3 text-body outline-none focus:border-primary focus:ring-2 focus:ring-primary-light"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="lastName" className="text-body-sm font-medium text-ink">
                Last name
              </label>
              <input
                id="lastName"
                value={form.lastName}
                onChange={update('lastName')}
                className="h-10 rounded-sm border border-border-strong px-3 text-body outline-none focus:border-primary focus:ring-2 focus:ring-primary-light"
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="email" className="text-body-sm font-medium text-ink">
              Work email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={update('email')}
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
              autoComplete="new-password"
              required
              minLength={12}
              value={form.password}
              onChange={update('password')}
              aria-describedby="password-hint"
              className="h-10 rounded-sm border border-border-strong px-3 text-body outline-none focus:border-primary focus:ring-2 focus:ring-primary-light"
            />
            <p id="password-hint" className="text-caption text-ink-muted">
              At least 12 characters.
            </p>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="h-10 rounded-sm bg-primary px-4 text-body font-medium text-white transition-colors hover:bg-primary-hover disabled:bg-ink-disabled"
          >
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="mt-4 text-body-sm text-ink-muted">
          Already registered?{' '}
          <Link href="/login" className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
