import { Controller, Get, Query, Inject } from '@nestjs/common';
import { z } from 'zod';
import type { OrganisationContext } from '@billing/types';
import { zodPipe } from '../common/pipes/zod-validation.pipe.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { CurrentOrganisation } from '../common/decorators/current-context.decorator.js';
import { DashboardService } from './dashboard.service.js';

/**
 * Dashboard API (TICKET-039, TICKET-040).
 *
 * Gated on dashboard:view, which every role holds — the dashboard is the
 * landing page. The figures are organisation-scoped by the guard and RLS.
 */
const recentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

@Controller({ path: 'dashboard', version: '1' })
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboard: DashboardService) {}

  @RequirePermission('dashboard:view')
  @Get('summary')
  summary(@CurrentOrganisation() org: OrganisationContext) {
    return this.dashboard.summary(org);
  }

  @RequirePermission('dashboard:view')
  @Get('recent')
  recent(
    @CurrentOrganisation() org: OrganisationContext,
    @Query(zodPipe(recentQuerySchema)) query: z.infer<typeof recentQuerySchema>,
  ) {
    return this.dashboard.recent(org, query.limit);
  }
}
