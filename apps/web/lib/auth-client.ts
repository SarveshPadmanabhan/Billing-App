import { createAuthClient } from 'better-auth/react';

/**
 * Better Auth browser client.
 *
 * Only the public API URL is used here. No secret ever reaches this file —
 * BETTER_AUTH_SECRET stays server-side, and the session lives in an HttpOnly
 * cookie this code cannot read (Frontend Spec §37).
 */
export const authClient = createAuthClient({
  baseURL: `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/v1/auth`,
  fetchOptions: {
    // Required so the session cookie is sent cross-origin (web:3000 -> api:4000).
    credentials: 'include',
  },
});

export const { signIn, signUp, signOut, useSession } = authClient;
