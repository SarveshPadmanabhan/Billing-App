import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../main.js';

/**
 * Serverless entrypoint for the NestJS API.
 *
 * Bundled by scripts/build-api-function.mjs and loaded by the Next.js route
 * at apps/web/app/api/v1/[...path]. It lives inside apps/api so it compiles
 * with the API's own tsconfig — the decorator settings NestJS needs.
 *
 * Nest is designed around a long-running process, so the whole application is
 * built once and cached on the module scope. Vercel reuses a warm function
 * instance across invocations, so this runs on a cold start only; rebuilding
 * per request would add seconds to every call and re-open a database pool each
 * time.
 *
 * The promise, not the instance, is what is cached: two concurrent requests
 * arriving on the same cold instance would otherwise each start their own
 * bootstrap. Awaiting one shared promise gives them the same app.
 */

let appPromise: Promise<import('http').RequestListener> | null = null;

async function handler(): Promise<import('http').RequestListener> {
  const { app } = await createApp();

  // init(), not listen(): the platform owns the socket. This runs the same
  // middleware and route registration a listening server would, then hands
  // back the underlying Express instance to serve one request at a time.
  await app.init();

  return app.getHttpAdapter().getInstance() as import('http').RequestListener;
}

export default async function vercelHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    appPromise ??= handler();
    const express = await appPromise;
    express(req, res);
  } catch (error) {
    // A failed bootstrap must not poison the cached promise: the next request
    // on this instance would await the same rejection forever and the function
    // would never recover without a redeploy.
    appPromise = null;

    // Startup failures (a missing env var, an unreachable database) would
    // otherwise surface as an opaque FUNCTION_INVOCATION_FAILED with nothing
    // in the logs pointing at the cause.
    console.error('API bootstrap failed:', error instanceof Error ? error.stack : error);

    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    // No detail in the body: the message can name internals. It goes to the
    // logs above instead.
    res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'API unavailable' } }));
  }
}
