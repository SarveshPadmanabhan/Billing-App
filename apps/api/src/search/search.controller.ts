import { Controller, Get, Query, Inject } from '@nestjs/common';
import { z } from 'zod';
import type { OrganisationContext } from '@billing/types';
import { zodPipe } from '../common/pipes/zod-validation.pipe.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { CurrentOrganisation } from '../common/decorators/current-context.decorator.js';
import { SearchService } from './search.service.js';

/**
 * Global search (TICKET-036).
 *
 * Gated on dashboard:view — the lowest bar any authenticated member clears.
 * Per-type visibility is then decided inside the service from the caller's
 * role, so a VIEWER sees only what they may view rather than being refused
 * outright.
 */
const searchQuerySchema = z.object({
  q: z.string().trim().max(200).default(''),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

@Controller({ path: 'search', version: '1' })
export class SearchController {
  constructor(@Inject(SearchService) private readonly search: SearchService) {}

  @RequirePermission('dashboard:view')
  @Get()
  find(
    @CurrentOrganisation() org: OrganisationContext,
    @Query(zodPipe(searchQuerySchema)) query: z.infer<typeof searchQuerySchema>,
  ) {
    return this.search.search(org, query.q, query.limit);
  }
}
