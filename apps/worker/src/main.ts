import { Worker, type Job } from 'bullmq';
import pino from 'pino';
import { loadServerEnv } from '@billing/config';
import { connection, QUEUE_NAMES, type TenantJobData } from './queues.js';

/**
 * Background worker entry point (TICKET-001 scaffold).
 *
 * Phase 1 stands up the process, connection handling, logging, and graceful
 * shutdown. Job processors are added by the PDF, email, and notification
 * tickets in Phase 2 — each will run its database work inside `withTenant`
 * using the organisationId carried on the job.
 */

const env = loadServerEnv();
const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: ['*.password', '*.token', '*.secret', '*.apiKey'], censor: '[REDACTED]' },
});

/** Placeholder processor: logs and succeeds. Replaced per queue in Phase 2. */
async function notImplemented(job: Job<TenantJobData>): Promise<void> {
  logger.warn(
    { jobId: job.id, queue: job.queueName, organisationId: job.data.organisationId },
    'No processor registered for this queue yet',
  );
}

const workers = Object.values(QUEUE_NAMES).map(
  (name) =>
    new Worker<TenantJobData>(name, notImplemented, {
      connection,
      concurrency: 5,
    }),
);

for (const worker of workers) {
  worker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, queue: worker.name, attempts: job?.attemptsMade, err: error },
      'Job failed',
    );
  });
  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, queue: worker.name }, 'Job completed');
  });
}

logger.info({ queues: Object.values(QUEUE_NAMES) }, 'Worker started');

/**
 * Graceful shutdown: let in-flight jobs finish before exiting, so a PDF render
 * or email send is not abandoned mid-way on deploy.
 */
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down worker');
  await Promise.all(workers.map((w) => w.close()));
  await connection.quit();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
