import type { NextConfig } from 'next';
import { join as pathJoin } from 'node:path';

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship as TypeScript source.
  transpilePackages: ['@billing/types', '@billing/validation'],
  /**
   * The prebuilt API bundle must not be re-bundled by webpack.
   *
   * api-bundle/index.cjs already has NestJS's optional integrations and
   * Playwright marked external (see scripts/build-api-function.mjs). Webpack
   * walks those require() calls anyway and fails the build on
   * @grpc/proto-loader, chromium-bidi and friends — packages nothing here
   * uses. Listing it as a server external package makes Next require() it at
   * runtime instead, which is the whole point of prebuilding it.
   */
  serverExternalPackages: ['@billing/api-bundle', 'playwright', 'playwright-core', '@prisma/client'],
  /**
   * Force the Prisma engine into the deployed function.
   *
   * The API bundle require()s @prisma/client, but it is externalised, so
   * webpack never looks inside it and Vercel's file tracing cannot see the
   * dependency — the function deployed without Prisma and failed at runtime
   * with "Cannot find module '@prisma/client'". Tracing follows JS imports
   * and would in any case miss the native .so engine that Prisma loads by
   * path at runtime, so both are named explicitly.
   */
  outputFileTracingRoot: pathJoin(__dirname, '../../'),
  outputFileTracingIncludes: {
    /**
     * The KEY is matched as a glob against route paths, and this route's real
     * path contains "[...path]" — square brackets are character classes, so
     * the literal key never matches itself. "/api/**" matches it plainly.
     *
     * The VALUES are globs relative to outputFileTracingRoot (the repo root),
     * not to this config's directory; a "../../" prefix silently matches
     * nothing.
     */
    '/api/**': [
      'node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/**',
      'node_modules/.pnpm/@prisma+client*/node_modules/@prisma/client/**',
      'packages/api-bundle/**',
    ],
  },
  webpack(config, { isServer }) {
    /**
     * Keep the prebuilt API bundle out of webpack entirely.
     *
     * It is already a complete CommonJS bundle whose optional NestJS
     * integrations and Playwright are external on purpose. Webpack otherwise
     * walks those require() calls and fails on @grpc/proto-loader and
     * chromium-bidi, which nothing here uses. serverExternalPackages alone
     * does not cover a workspace package, so it is externalised explicitly.
     *
     * The request is emitted verbatim as require("@billing/api-bundle"), so
     * Node resolves it through node_modules at runtime — no absolute build
     * path (gone when the function runs) and no reliance on .next internals.
     */
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
        ({ request }: { request?: string }, callback: (err?: unknown, result?: string) => void) =>
          request === '@billing/api-bundle'
            ? callback(undefined, 'commonjs @billing/api-bundle')
            : callback(),
      ];
    }

    /**
     * Keep the prebuilt API bundle out of webpack entirely.
     *
     * It is already a complete CommonJS bundle with NestJS's optional
     * integrations left external on purpose. Letting webpack walk it makes it
     * chase those require() calls and fail on @grpc/proto-loader and
     * chromium-bidi — packages this app never uses. Marking it external emits
     * a plain require() that Node resolves at runtime.
     */
    /**
     * Workspace packages use NodeNext-style `./foo.js` specifiers, which is
     * correct for the NestJS API but unresolvable by webpack's bundler
     * resolution against `.ts` source. This maps the extension so both
     * consumers can share one set of sources.
     *
     * Only surfaced once a runtime value (hasPermission) was imported —
     * type-only imports are erased before webpack sees them.
     */
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
  // Never expose the framework version in response headers.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
