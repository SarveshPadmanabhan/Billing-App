import { createAuthClient } from 'better-auth/react';

/**
 * Better Auth browser client.
 *
 * Only the public API URL is used here. No secret ever reaches this file —
 * BETTER_AUTH_SECRET stays server-side, and the session lives in an HttpOnly
 * cookie this code cannot read (Frontend Spec §37).
 */
export const authClient = createAuthClient({
  /**
   * Absolute, unlike the plain fetch client.
   *
   * Better Auth validates this with `new URL()` and rejects a relative path,
   * which fails the build during prerendering of /login rather than at
   * runtime. window.location.origin gives the same-origin URL the deployment
   * needs; the string fallback is only for the server-side prerender pass,
   * where no request is ever made from this client.
   */
  baseURL: `${
    (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '') ||
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000')
  }/api/v1/auth`,
  fetchOptions: {
    // Required in development, where web:3000 and api:4000 are separate
    // origins. Harmless same-origin in production.
    credentials: 'include',
  },
});

export const { signIn, signUp, signOut, useSession } = authClient;
