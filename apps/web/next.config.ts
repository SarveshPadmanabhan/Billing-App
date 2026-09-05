import type { NextConfig } from 'next';
import { resolve as pathResolve } from 'node:path';

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
  serverExternalPackages: ['playwright', 'playwright-core', '@prisma/client'],
  webpack(config, { isServer }) {
    /**
     * Keep the prebuilt API bundle out of webpack entirely.
     *
     * It is already a complete CommonJS bundle with NestJS's optional
     * integrations left external on purpose. Letting webpack walk it makes it
     * chase those require() calls and fail on @grpc/proto-loader and
     * chromium-bidi — packages this app never uses. Marking it external emits
     * a plain require() that Node resolves at runtime.
     */
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
        ({ request }: { request?: string }, callback: (err?: unknown, result?: string) => void) => {
          if (request?.includes('api-bundle/index.cjs')) {
            // Absolute: the emitted require() runs from .next/server/app/...,
            // where the original relative specifier no longer resolves.
            const abs = pathResolve(process.cwd(), 'api-bundle/index.cjs');
            return callback(undefined, `commonjs ${abs}`);
          }
          return callback();
        },
      ];
    }

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
