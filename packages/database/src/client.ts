import { PrismaClient, Prisma } from '@prisma/client';

export { Prisma };
export * from '@prisma/client';

/**
 * Prisma client singleton.
 *
 * Connects as the runtime role (billing_app), which has neither SUPERUSER nor
 * BYPASSRLS — so every RLS policy applies. Migrations use a different role via
 * DATABASE_MIGRATION_URL.
 */
/**
 * Interactive-transaction limits.
 *
 * 10s is comfortable against a local database, where a round trip costs ~1ms.
 * Against a hosted database in another region each trip costs ~100ms, so a
 * transaction doing many queries — or a concurrency test firing 64 at once —
 * can exceed it without anything being wrong. Tunable rather than raised
 * outright, since a long timeout also delays detecting a genuine stall.
 */
const DEFAULT_TX_TIMEOUT_MS = Number(process.env.DB_TX_TIMEOUT_MS ?? 10_000);
const DEFAULT_TX_MAX_WAIT_MS = Number(process.env.DB_TX_MAX_WAIT_MS ?? 5_000);

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function createPrismaClient(options?: { log?: Prisma.LogLevel[] }): PrismaClient {
  return new PrismaClient({
    log: options?.log ?? (process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']),
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

/**
 * Cached on globalThis in EVERY environment, production included.
 *
 * In development this survives hot reloads, which is the usual reason for the
 * pattern. In a serverless deployment it matters more: a warm function
 * instance may re-evaluate this module, and without the cache each evaluation
 * would construct another PrismaClient with its own connection pool while the
 * previous one still holds connections. Across many warm instances that
 * exhausts Postgres, which surfaces as intermittent "too many connections"
 * under load rather than as an obvious failure.
 *
 * Set DATABASE_URL's connection_limit low (1 for serverless) and let the
 * Supabase pooler absorb concurrency instead.
 */
globalForPrisma.prisma = prisma;

/** Client scoped to one organisation for the life of a transaction. */
export type TenantClient = Omit<
  Prisma.TransactionClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * Any well-formed UUID, not just RFC-4122 v4.
 *
 * Deliberately does NOT constrain the version/variant nibbles: Postgres accepts
 * any 128-bit value in its `uuid` type, and rejecting e.g. a nil UUID here
 * would throw where the database would simply match no rows. This is a
 * SQL-injection guard, not a UUID-conformance check.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

/**
 * Run `fn` inside a transaction with the Postgres tenant context set, so RLS
 * restricts every statement to `organisationId`.
 *
 * The id is validated as a UUID and interpolated only via a parameterised
 * `set_config`, so a forged value cannot inject SQL — it simply fails to match
 * any row.
 *
 * `set_config(..., true)` makes the setting transaction-local: it is discarded
 * on commit or rollback and cannot leak to the next borrower of this pooled
 * connection. That property is what makes RLS safe under connection pooling.
 */
export async function withTenant<T>(
  organisationId: string,
  fn: (tx: TenantClient) => Promise<T>,
  client: PrismaClient = prisma,
  options?: { timeout?: number; maxWait?: number; userId?: string },
): Promise<T> {
  if (!UUID_PATTERN.test(organisationId)) {
    throw new TenantContextError('organisationId must be a valid UUID');
  }
  if (options?.userId && !UUID_PATTERN.test(options.userId)) {
    throw new TenantContextError('userId must be a valid UUID');
  }

  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_organisation_id', ${organisationId}, true)`;
      if (options?.userId) {
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${options.userId}, true)`;
      }
      return fn(tx);
    },
    {
      timeout: options?.timeout ?? DEFAULT_TX_TIMEOUT_MS,
      maxWait: options?.maxWait ?? DEFAULT_TX_MAX_WAIT_MS,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
}

/**
 * Run `fn` with USER context but no tenant context.
 *
 * This is the bootstrap path: resolving which organisations a user belongs to,
 * and the membership lookup that establishes tenant context on each request.
 * RLS still applies — the membership_visibility policy restricts rows to
 * `user_id = current_user_id()`, so this cannot read another user's
 * memberships. It is a narrower and safer tool than `withoutTenant`.
 */
export async function withUser<T>(
  userId: string,
  fn: (tx: TenantClient) => Promise<T>,
  client: PrismaClient = prisma,
  options?: { timeout?: number; maxWait?: number },
): Promise<T> {
  if (!UUID_PATTERN.test(userId)) {
    throw new TenantContextError('userId must be a valid UUID');
  }

  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      return fn(tx);
    },
    {
      timeout: options?.timeout ?? DEFAULT_TX_TIMEOUT_MS,
      maxWait: options?.maxWait ?? DEFAULT_TX_MAX_WAIT_MS,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
}

/**
 * Escape hatch for genuinely cross-tenant work: health checks, Better Auth's
 * own user/session tables, and admin tooling.
 *
 * Every call site must be justified — this bypasses the RLS safety net and
 * leaves application-level checks as the only control. Prefer `withUser` for
 * anything keyed to a specific user.
 */
export async function withoutTenant<T>(
  reason: 'authentication' | 'health-check' | 'migration' | 'admin-tooling',
  fn: (client: PrismaClient) => Promise<T>,
  client: PrismaClient = prisma,
): Promise<T> {
  void reason; // Documented at the call site; kept in the signature deliberately.
  return fn(client);
}
