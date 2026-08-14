import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { loadServerEnv } from '@billing/config';

/**
 * Queue definitions (Tech Arch Doc §12).
 *
 * Phase 1 establishes the queue topology and connection handling only; the
 * processors that render PDFs and send email arrive with those tickets. Having
 * the wiring in place now means Phase 2 adds handlers rather than plumbing.
 */

const env = loadServerEnv();

export const connection = new Redis(env.REDIS_URL, {
  // BullMQ requires this: it uses blocking commands that must not be
  // interrupted by the client's own retry logic.
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

export const QUEUE_NAMES = {
  GENERATE_INVOICE_PDF: 'generate-invoice-pdf',
  GENERATE_QUOTATION_PDF: 'generate-quotation-pdf',
  SEND_EMAIL: 'send-email',
  SEND_PAYMENT_REMINDER: 'send-payment-reminder',
  GENERATE_RECEIPT: 'generate-receipt',
  PROCESS_NOTIFICATION: 'process-notification',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Retry policy for every queue.
 *
 * Exponential backoff with a bounded attempt count (Tech Arch Doc §12). Failed
 * jobs are retained so a PDF or email failure can be investigated rather than
 * silently disappearing — Security Doc §23 requires that a background failure
 * never destroys the financial record it relates to.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function createQueue(name: QueueName): Queue {
  return new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
}

/**
 * Every job carries its organisation so the processor can set tenant context
 * before touching the database. A job without it must be rejected — background
 * work is not exempt from tenant isolation.
 */
export interface TenantJobData {
  organisationId: string;
  requestId?: string;
}
