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
    S3_REGION: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    EMAIL_PROVIDER: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    EMAIL_API_KEY: z.string().optional(),

    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    COOKIE_DOMAIN: z.string().default('localhost'),
    ENCRYPTION_KEY: z.string().optional(),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

    SENTRY_DSN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
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

  const parsed = serverSchema.safeParse(source);
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
