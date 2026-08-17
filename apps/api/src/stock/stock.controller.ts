import { Controller, Get, Post, Patch, Body, Param, Query, Inject } from '@nestjs/common';
import {
  createStockItemSchema,
  updateStockItemSchema,
  adjustStockSchema,
  stockListQuerySchema,
  type CreateStockItemInput,
  type UpdateStockItemInput,
  type AdjustStockInput,
  type StockListQuery,
} from '@billing/validation';
import type { OrganisationContext } from '@billing/types';
import { zodPipe } from '../common/pipes/zod-validation.pipe.js';
import { CurrentAuth, CurrentOrganisation } from '../common/decorators/current-context.decorator.js';
import type { AuthContext } from '../common/types/request.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { StockService } from './stock.service.js';

/** Stock items and adjustments (company-scoped). */
@Controller({ path: 'stock', version: '1' })
export class StockController {
  constructor(@Inject(StockService) private readonly stock: StockService) {}

  @RequirePermission('stock:view')
  @Get()
  async list(
    @CurrentOrganisation() org: OrganisationContext,
    @Query(zodPipe(stockListQuerySchema)) query: StockListQuery,
  ) {
    return this.stock.list(org, query);
  }

  @RequirePermission('stock:view')
  @Get(':id')
  async get(@CurrentOrganisation() org: OrganisationContext, @Param('id') id: string) {
    return this.stock.get(org, id);
  }

  @RequirePermission('stock:write')
  @Post()
  async create(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Body(zodPipe(createStockItemSchema)) input: CreateStockItemInput,
  ) {
    return this.stock.create(org, input, auth.user.userId);
  }

  @RequirePermission('stock:write')
  @Patch(':id')
  async update(
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Body(zodPipe(updateStockItemSchema)) input: UpdateStockItemInput,
  ) {
    return this.stock.update(org, id, input);
  }

  @RequirePermission('stock:write')
  @Post(':id/adjust')
  async adjust(
    @CurrentAuth() auth: AuthContext,
    @CurrentOrganisation() org: OrganisationContext,
    @Param('id') id: string,
    @Body(zodPipe(adjustStockSchema)) input: AdjustStockInput,
  ) {
    return this.stock.adjust(org, id, input, auth.user.userId);
  }
}
