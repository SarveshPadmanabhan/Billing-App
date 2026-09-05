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
  // A static relative import so webpack traces the bundle as a dependency of
  // this route and Vercel packages it with the function. cwd-based paths were
  // tried and fail: cwd is apps/web under `next start` but the project root in
  // the deployed function.
  const mod = (await import('../../../../api-bundle/index.cjs')) as {
    default?: NodeHandler;
  };
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
    return Response.json(
      { error: { code: 'INTERNAL_ERROR', message: 'API unavailable' } },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
export const OPTIONS = handle;
