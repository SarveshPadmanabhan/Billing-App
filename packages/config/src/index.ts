import { z } from 'zod';

/**
 * Server-side environment contract.
 *
 * Parsed once at process boot. A missing or malformed variable fails loudly
 * here rather than surfacing as an undefined deep inside a financial code path.
 *
 * Nothing in this module may be imported by browser code — it reads secrets.
 * The web app gets its (public-only) config from `packages/config/src/public`.
 */

const nonEmpty = (name: string) =>
  z.string({ required_error: `${name} is required` }).min(1, `${name} must not be empty`);

const serverSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_NAME: z.string().default('BillingApp'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    APP_URL: z.string().url(),
    API_URL: z.string().url(),
    /**
     * Port to bind.
     *
     * Container hosts (Railway, Render, Fly, Heroku) assign a port at runtime
     * and inject it as PORT; the app MUST bind that one or the platform's
     * router reaches nothing and every request times out. `loadServerEnv` maps
     * PORT onto this field when present, so API_PORT stays the single name the
     * application reads while still honouring the host.
     */
    API_PORT: z.coerce.number().int().positive().default(4000),

    // Runtime connection. Uses a role WITHOUT rolbypassrls so RLS applies.
    DATABASE_URL: nonEmpty('DATABASE_URL').startsWith('postgresql://'),
    // Schema-owning role, used only by migrations.
    DATABASE_MIGRATION_URL: z.string().startsWith('postgresql://').optional(),

    BETTER_AUTH_SECRET: nonEmpty('BETTER_AUTH_SECRET').min(
      32,
      'BETTER_AUTH_SECRET must be at least 32 characters',
    ),
    BETTER_AUTH_URL: z.string().url(),
    SESSION_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(604800),
    SESSION_UPDATE_AGE_SECONDS: z.coerce.number().int().positive().default(86400),

    REDIS_URL: z.string().startsWith('redis://').default('redis://localhost:6379'),

    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    // MinIO requires path-style addressing; AWS S3 uses virtual-host style.
    S3_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Download links are deliberately short-lived (Security Doc §35).
    S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

    /**
     * How PDFs are rendered.
     *
     * 'playwright' launches a local Chromium and needs a host that can carry
     * the browser. 'browserless' posts the HTML to a remote renderer, which is
     * the only option on serverless platforms — a Chromium build exceeds
     * Vercel's 250MB unzipped function limit on its own.
     */
    PDF_RENDERER: z.enum(['playwright', 'browserless']).default('playwright'),
    BROWSERLESS_ENDPOINT: z.string().url().default('https://production-sfo.browserless.io'),
    /** Server-side secret. Must never appear in a NEXT_PUBLIC_ variable. */
    BROWSERLESS_TOKEN: z.string().optional(),
    /**
     * Kept under the platform's function timeout so a hung render returns our
     * own error with a request id, rather than the platform killing the
     * function and returning an opaque 504.
     */
    PDF_RENDER_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),

    EMAIL_PROVIDER: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    EMAIL_API_KEY: z.string().optional(),

    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    COOKIE_DOMAIN: z.string().default('localhost'),
    /**
     * Set true when the web app and the API are on different sites, as in the
     * split Vercel (web) + Railway (API) deployment. It switches the session
     * cookie to SameSite=None so the browser actually sends it cross-site.
     *
     * Left false for local development and single-host deployments, where
     * SameSite=Lax is the stronger and correct choice.
     */
    CROSS_SITE_COOKIES: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    ENCRYPTION_KEY: z.string().optional(),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

    SENTRY_DSN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    /**
     * Checked in EVERY environment, deliberately above the production-only
     * block below.
     *
     * A cross-site cookie is sent with SameSite=None, which browsers reject
     * unless it is also Secure — so this combination is broken wherever it
     * appears, not just in production. Placing it after the early return left
     * it unreachable in development, which a test caught only because it
     * asserted the guard could actually fail (ADR-009 rule 2).
     */
    if (env.CROSS_SITE_COOKIES && !env.APP_URL.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CROSS_SITE_COOKIES'],
        message:
          'CROSS_SITE_COOKIES requires HTTPS: SameSite=None cookies are rejected without Secure',
      });
    }

    if (env.NODE_ENV !== 'production') return;

    // Production-only invariants. Dev placeholders must never reach prod.
    if (env.BETTER_AUTH_SECRET.startsWith('dev-only-')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BETTER_AUTH_SECRET'],
        message: 'Development placeholder secret must not be used in production',
      });
    }
    if (env.ENCRYPTION_KEY?.startsWith('dev-only-')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENCRYPTION_KEY'],
        message: 'Development placeholder encryption key must not be used in production',
      });
    }
    if (!env.APP_URL.startsWith('https://') || !env.API_URL.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_URL'],
        message: 'Production URLs must use HTTPS',
      });
    }
    // Catching this at startup rather than on the first customer download:
    // browserless without a token cannot render anything.
    if (env.PDF_RENDERER === 'browserless' && !env.BROWSERLESS_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BROWSERLESS_TOKEN'],
        message: 'PDF_RENDERER=browserless requires BROWSERLESS_TOKEN',
      });
    }
    if (env.CORS_ORIGINS.includes('localhost') || env.CORS_ORIGINS === '*') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'Production CORS_ORIGINS must not include localhost or a wildcard',
      });
    }
  });

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | undefined;

/**
 * Parse and cache server environment. Throws with a readable, secret-free
 * report listing every offending variable name (never its value).
 */
export function loadServerEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  if (cached) return cached;

  // A platform-assigned PORT wins over API_PORT: on Railway and similar hosts
  // it is the only port the router forwards to. An explicitly set API_PORT is
  // still honoured when the platform sets no PORT at all.
  const withPort: NodeJS.ProcessEnv = source.PORT
    ? { ...source, API_PORT: source.PORT }
    : source;

  const parsed = serverSchema.safeParse(withPort);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${problems}\n\n` +
        'Copy .env.example to .env and fill in the required values.',
    );
  }

  cached = parsed.data;
  return cached;
}

/** Test-only. Clears the memoised env so a new one can be parsed. */
export function resetServerEnvCache(): void {
  cached = undefined;
}

export function corsOrigins(env: ServerEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export const isProduction = (env: ServerEnv) => env.NODE_ENV === 'production';
export const isTest = (env: ServerEnv) => env.NODE_ENV === 'test';
