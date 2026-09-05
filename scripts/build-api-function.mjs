/**
 * Bundle the NestJS API into one CommonJS file for the Vercel function.
 *
 * Why bundle ourselves instead of letting Vercel do it:
 *
 * 1. The workspace packages (@billing/config, @billing/database, …) ship as
 *    TypeScript source with NodeNext "./foo.js" specifiers. Vercel's bundler
 *    resolves the function's imports against node_modules and cannot follow
 *    those into .ts files across pnpm's symlinked workspace.
 *
 * 2. NestJS calls require() on optional integrations it does not need —
 *    @nestjs/microservices, @nestjs/websockets, class-validator,
 *    class-transformer — behind runtime feature checks. Any bundler that
 *    walks every require() fails on those unless told they are external.
 *    Installing them is not a fix: @nestjs/microservices then drags in
 *    gRPC, AMQP, MQTT and NATS, none of which this application uses.
 *
 * Marking them external leaves the require() calls in place. They only
 * execute if the app actually uses those features, which it never does — the
 * app validates with Zod and serves plain HTTP.
 */
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Optional NestJS integrations this app does not use. */
const NEST_OPTIONAL = [
  '@nestjs/microservices',
  '@nestjs/microservices/microservices-module',
  '@nestjs/websockets',
  '@nestjs/websockets/socket-module',
  'class-validator',
  'class-transformer',
];

/**
 * Left external and resolved at runtime from node_modules.
 *
 * @prisma/client generates a native query engine binary that cannot be
 * inlined, and playwright is only reachable through a dynamic import that
 * never runs in production (PDF_RENDERER=browserless).
 */
const RUNTIME_EXTERNAL = ['@prisma/client', '.prisma/client', 'playwright', 'playwright-core'];

await mkdir(resolve(root, 'packages/api-bundle'), { recursive: true });

const result = await build({
  entryPoints: [resolve(root, 'apps/api/src/serverless/handler.ts')],
  outfile: resolve(root, 'packages/api-bundle/index.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // Nest reads design-time type metadata via reflect-metadata at runtime;
  // without decorator metadata the DI container cannot resolve constructors.
  tsconfig: resolve(root, 'apps/api/tsconfig.json'),
  external: [...NEST_OPTIONAL, ...RUNTIME_EXTERNAL],
  logLevel: 'info',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`API function bundle: ${(bytes / 1024 / 1024).toFixed(1)}MB`);
