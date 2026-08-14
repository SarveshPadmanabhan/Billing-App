import { Controller, Get } from '@nestjs/common';
import { prisma } from '@billing/database';
import { Public } from '../common/decorators/public.decorator.js';

/**
 * Health checks (TICKET-001).
 *
 * Deliberately unauthenticated but information-free: it reports reachability
 * only — no version, no hostname, no connection strings — because it is
 * exposed to load balancers and therefore, in practice, to the internet.
 */
@Controller({ path: 'health', version: '1' })
export class HealthController {
  @Public()
  @Get()
  liveness() {
    return { status: 'ok' };
  }

  /** Readiness: can we actually serve traffic (database reachable)? */
  @Public()
  @Get('ready')
  async readiness() {
    const checks: Record<string, 'ok' | 'error'> = {};

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    const healthy = Object.values(checks).every((v) => v === 'ok');
    return { status: healthy ? 'ok' : 'degraded', checks };
  }
}
