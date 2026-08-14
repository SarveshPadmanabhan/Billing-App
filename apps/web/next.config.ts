import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship as TypeScript source.
  transpilePackages: ['@billing/types', '@billing/validation'],
  webpack(config) {
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
