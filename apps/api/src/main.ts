import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import express from 'express';
import { loadServerEnv, corsOrigins } from '@billing/config';
import { AppModule } from './app.module.js';
import { createLogger } from './common/logging/logger.js';

/**
 * Build the fully configured Nest application without starting a listener.
 *
 * Split out so the serverless entrypoint (api/index.ts) and the long-running
 * server below share ONE middleware chain. Duplicating this setup is how a
 * deployment ends up with, say, CORS or the Better Auth mount configured in
 * one place and not the other — which fails only in production, and only for
 * the requests that touch the missing piece.
 */
export async function createApp() {
  // Parsed first: a misconfigured environment must fail before the server
  // starts listening, not on the first request that needs a missing value.
  const env = loadServerEnv();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.use(
    helmet({
      contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false,
      hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  app.use(cookieParser());

  /**
   * CORS is configured BEFORE the Better Auth mount below.
   *
   * Nest's enableCors installs Express middleware in call order, so registering
   * it after the auth handler left OPTIONS preflights to Better Auth, which
   * answers them without CORS headers — the browser then blocked every
   * cross-origin sign-in. curl does not send preflights, so this only appeared
   * once the flow ran in a real browser.
   */
  app.enableCors({
    origin: corsOrigins(env),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'X-Request-Id', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });

  /**
   * Better Auth handler, mounted BEFORE express.json().
   *
   * Order is deliberate: Better Auth reads the raw request stream itself, so
   * a JSON body parser running first would consume it and leave the handler
   * with an empty body. Everything under /api/v1/auth/* that Better Auth owns
   * (sign-up, sign-in, sign-out, verification, password reset) is served here;
   * our own additions (/me, /switch-organisation, /sessions) fall through to
   * the Nest router below.
   */
  const { toNodeHandler } = await import('better-auth/node');
  const { auth } = await import('./auth/auth.config.js');
  const betterAuthHandler = toNodeHandler(auth);

  // Paths under /api/v1/auth that this application owns rather than Better
  // Auth. They must fall through to the Nest router, so they are excluded
  // here instead of letting the mount swallow the whole subtree.
  const APP_OWNED_AUTH_ROUTES = new Set([
    '/me',
    '/switch-organisation',
    '/sessions',
    '/revoke-other-sessions',
  ]);

  app.use('/api/v1/auth', (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const subPath = req.path.replace(/\/+$/, '') || '/';
    if (APP_OWNED_AUTH_ROUTES.has(subPath)) return next();
    return betterAuthHandler(req, res);
  });

  // /api/v1/... (Tech Arch Doc §6)
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Caps request size to blunt the oversized-payload probe in Security Doc §33.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  return { app, env };
}

async function bootstrap() {
  const { app, env } = await createApp();
  const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');

  // Only meaningful for a long-running process; a serverless function is torn
  // down by the platform instead.
  app.enableShutdownHooks();

  await app.listen(env.API_PORT, '0.0.0.0');

  logger.info(
    { port: env.API_PORT, env: env.NODE_ENV, baseUrl: `${env.API_URL}/api/v1` },
    'API listening',
  );
}

/**
 * Start a listener only when this file is the process entrypoint.
 *
 * The serverless handler imports `createApp` from this module. Without this
 * guard, that import would also call bootstrap() and try to bind a port inside
 * a function that has none — the platform reports it as an opaque invocation
 * failure with nothing in the logs to explain it.
 */
const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  /[\\/]main\.(js|ts)$/.test(process.argv[1]);

if (isEntrypoint) {
  bootstrap().catch((error) => {
    // No logger here: this path includes "env failed to parse", where the
    // logger's own config is unavailable.
    console.error('Failed to start API:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
