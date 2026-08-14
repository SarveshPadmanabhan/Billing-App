import Link from 'next/link';

/** App Router 404. */

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas px-4 text-center">
      <h1 className="text-h1 text-ink">Page not found</h1>
      <p className="max-w-md text-body text-ink-muted">
        The page you&apos;re looking for doesn&apos;t exist or you don&apos;t have access to it.
      </p>
      <Link
        href="/dashboard"
        className="flex h-10 items-center rounded-sm bg-primary px-4 text-body font-medium text-white hover:bg-primary-hover"
      >
        Back to dashboard
      </Link>
    </main>
  );
}
