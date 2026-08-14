import { Injectable, Inject } from '@nestjs/common';
import { prisma, type TenantClient, Prisma } from '@billing/database';
import type { AuditAction } from '@billing/types';
import type { AppLogger } from '../logging/logger.js';

/**
 * Audit trail (Security Doc §21).
 *
 * Two entry points:
 *   - `record`  — inside an existing transaction, so the audit row commits
 *                 atomically with the change it describes. Preferred for
 *                 financial mutations: no committed change without its log.
 *   - `recordDetached` — outside any transaction, for events with no business
 *                 transaction to join (login success/failure).
 *
 * Never pass raw secrets in oldValues/newValues; `sanitise` strips known
 * sensitive keys as a backstop.
 */

export interface AuditEntry {
  organisationId?: string | null;
  userId?: string | null;
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'secret',
  'apikey',
  'api_key',
  'encryptionkey',
  'sessiontoken',
]);

function sanitise(values: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | undefined {
  if (!values) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    output[key] = SENSITIVE_KEYS.has(key.toLowerCase().replace(/[^a-z_]/g, '')) ? '[REDACTED]' : value;
  }
  return output as Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  constructor(@Inject('APP_LOGGER') private readonly logger: AppLogger) {}

  /** Write inside the caller's transaction. */
  async record(tx: TenantClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({ data: this.toRow(entry) });
  }

  /**
   * Write outside any transaction.
   *
   * Failures are logged, never thrown: a broken audit write must not turn a
   * successful login into a 500. Financial actions use `record` instead, where
   * the write is atomic and a failure correctly rolls the change back.
   */
  async recordDetached(entry: AuditEntry): Promise<void> {
    try {
      await prisma.$transaction(async (tx) => {
        if (entry.organisationId) {
          await tx.$executeRaw`SELECT set_config('app.current_organisation_id', ${entry.organisationId}, true)`;
        }
        await tx.auditLog.create({ data: this.toRow(entry) });
      });
    } catch (error) {
      this.logger.error(
        { err: error, action: entry.action, requestId: entry.requestId },
        'Failed to write audit log',
      );
    }
  }

  private toRow(entry: AuditEntry): Prisma.AuditLogUncheckedCreateInput {
    return {
      organisationId: entry.organisationId ?? null,
      userId: entry.userId ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      oldValues: sanitise(entry.oldValues),
      newValues: sanitise(entry.newValues),
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
      requestId: entry.requestId ?? null,
    };
  }
}
