import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route protection (TICKET-004, TICKET-008).
 *
 * This is a UX redirect, NOT a security control: it only checks that a session
 * cookie is present, never whether it is valid. Authorization is enforced by
 * the API on every request (Security Doc §12: "Hiding buttons in the frontend
 * is not security"). Its job is to send signed-out users to /login instead of
 * flashing an empty dashboard.
 */

const PUBLIC_PATHS = ['/login', '/register', '/forgot-password', '/reset-password'];

/**
 * Better Auth renames the cookie when secure cookies are enabled: the
 * `__Secure-` prefix is a browser-enforced guarantee that the cookie was set
 * over HTTPS. Production therefore carries a DIFFERENT name from development,
 * and checking only the bare name would find nothing on a deployed site —
 * every signed-in user bounced to /login, forever, with no error anywhere.
 * Both names are checked so one build works in both places.
 */
const SESSION_COOKIES = ['better-auth.session_token', '__Secure-better-auth.session_token'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (pathname === '/') {
    return NextResponse.redirect(new URL(hasSession ? '/dashboard' : '/login', request.url));
  }

  if (!hasSession && !isPublic) {
    const loginUrl = new URL('/login', request.url);
    // Preserve the destination so the user lands where they intended.
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (hasSession && isPublic) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  return NextResponse.next();
}

export const config = {
  /**
   * `api/` is excluded, and that exclusion is load-bearing.
   *
   * The API is served from this same origin: vercel.json rewrites /api/v1/*
   * to the serverless function. Without excluding it here, this middleware
   * runs FIRST and redirects every unauthenticated API call to /login — so
   * sign-in itself returns a 307 to the login page, and the browser reports
   * only "We could not create that account".
   *
   * It is not a security loss: this middleware was never an access control
   * (see the note at the top of this file), and the API authenticates every
   * request on its own.
   */
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
