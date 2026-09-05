import type { NextRequest } from 'next/server';
import { toWebResponse, type NodeHandler } from './node-bridge';

/**
 * The NestJS API, served from inside the Next.js app.
 *
 * Vercel only deploys functions that belong to the detected framework, so a
 * root-level api/ directory is never packaged when framework is "nextjs" —
 * requests fell through to Next.js and returned its 500 page
 * (x-matched-path: /500). An App Router catch-all is the shape that does get
 * deployed, so the API lives here and every /api/v1/* request reaches Nest.
 *
 * The Nest app is built once and cached on the module scope: Vercel reuses a
 * warm instance across invocations, so bootstrap runs on a cold start only.
 *
 * `_bundle.cjs` is produced by scripts/build-api-function.mjs before the
 * Next.js build. It is required lazily, inside the handler, so a module-load
 * failure surfaces as a logged 500 with a stack rather than a build-time
 * resolution error.
 */

export const runtime = 'nodejs';
// Never cache: every response depends on the session cookie.
export const dynamic = 'force-dynamic';
/**
 * Declared here rather than in vercel.json's `functions` map: that map matches
 * keys as globs, and this route's directory name contains square brackets,
 * which are glob character classes rather than literals.
 *
 * 60s is the ceiling a PDF render needs — the Browserless call itself is
 * capped at PDF_RENDER_TIMEOUT_MS (25s) so a hung render returns our own
 * error with a request id well before the platform kills the function.
 */
export const maxDuration = 60;

let handlerPromise: Promise<NodeHandler> | null = null;

async function loadHandler(): Promise<NodeHandler> {
  // Imported by package name, not by path. Path-based approaches were tried
  // and fail on Vercel: an absolute path resolved at build time points into
  // the build container, and a relative one depends on .next/server's internal
  // layout. A workspace package is resolved by Node the ordinary way and is
  // traced into the deployed function automatically.
  const mod = (await import('@billing/api-bundle')) as { default?: NodeHandler };
  return (mod.default ?? (mod as unknown as NodeHandler));
}

async function handle(request: NextRequest): Promise<Response> {
  try {
    handlerPromise ??= loadHandler();
    const handler = await handlerPromise;
    return await toWebResponse(handler, request);
  } catch (error) {
    // A failed load must not poison the cache: the next request on this
    // instance would await the same rejection forever.
    handlerPromise = null;
    console.error('API handler failed:', error instanceof Error ? error.stack : error);

    /**
     * Return the diagnostic in the response when DEBUG_API_ERRORS is set.
     *
     * Off by default and gated on an explicit environment variable, because
     * a stack trace names internal paths and module layout. It exists because
     * a failure reproducible only on the platform, with no accessible logs,
     * cannot be fixed by guessing — unset the variable once the cause is
     * known.
     */
    const body =
      process.env.DEBUG_API_ERRORS === 'true'
        ? {
            error: {
              code: 'INTERNAL_ERROR',
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack?.split('\n').slice(0, 12) : undefined,
              cwd: process.cwd(),
            },
          }
        : { error: { code: 'INTERNAL_ERROR', message: 'API unavailable' } };

    return Response.json(body, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
export const OPTIONS = handle;
