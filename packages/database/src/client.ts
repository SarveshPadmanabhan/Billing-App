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
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export function createPrismaClient(options?: { log?: Prisma.LogLevel[] }): PrismaClient {
  return new PrismaClient({
    log: options?.log ?? (process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']),
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

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
      timeout: options?.timeout ?? 10_000,
      maxWait: options?.maxWait ?? 5_000,
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
      timeout: options?.timeout ?? 10_000,
      maxWait: options?.maxWait ?? 5_000,
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
