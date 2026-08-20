import { Controller, Get, Query, Res, Inject } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { OrganisationContext } from '@billing/types';
import { zodPipe } from '../common/pipes/zod-validation.pipe.js';
import { CurrentOrganisation } from '../common/decorators/current-context.decorator.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { ReportsService } from './reports.service.js';

const revenueQuerySchema = z.object({
  /** How many months back, inclusive of the current one. */
  months: z.coerce.number().int().min(1).max(36).default(12),
});

/**
 * Reports.
 *
 * `report:view` already exists in the permission matrix and is held by every
 * role, so reporting needs no new permission. The figures are company-scoped
 * by the service, and RLS scopes them to the organisation underneath that.
 */
@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  @RequirePermission('report:view')
  @Get('aging')
  async aging(@CurrentOrganisation() org: OrganisationContext) {
    return this.reports.aging(org);
  }

  @RequirePermission('report:view')
  @Get('revenue')
  async revenue(
    @CurrentOrganisation() org: OrganisationContext,
    @Query(zodPipe(revenueQuerySchema)) query: { months: number },
  ) {
    return this.reports.revenue(org, query.months);
  }

  /**
   * CSV exports.
   *
   * Sent as a download rather than JSON, so these bypass the usual response
   * envelope — a spreadsheet cannot read {"data": ...}.
   */
  @RequirePermission('report:view')
  @Get('aging.csv')
  async agingCsv(@CurrentOrganisation() org: OrganisationContext, @Res() res: Response) {
    const report = await this.reports.aging(org);
    const rows = [
      ['Customer', 'Invoices', 'Oldest due', 'Current', '1-30', '31-60', '61-90', '90+', 'Total'],
      ...report.rows.map((r) => [
        r.customerName,
        String(r.invoiceCount),
        r.oldestDueDate,
        r.current,
        r.days1To30,
        r.days31To60,
        r.days61To90,
        r.days90Plus,
        r.total,
      ]),
      [
        'TOTAL',
        '',
        '',
        report.totals.current,
        report.totals.days1To30,
        report.totals.days31To60,
        report.totals.days61To90,
        report.totals.days90Plus,
        report.totals.total,
      ],
    ];
    send(res, `aging-${report.asOf}.csv`, rows);
  }

  @RequirePermission('report:view')
  @Get('revenue.csv')
  async revenueCsv(
    @CurrentOrganisation() org: OrganisationContext,
    @Query(zodPipe(revenueQuerySchema)) query: { months: number },
    @Res() res: Response,
  ) {
    const report = await this.reports.revenue(org, query.months);
    const rows = [
      ['Month', 'Invoices', 'Invoiced', 'Collected'],
      ...report.months.map((m) => [m.month, String(m.invoiceCount), m.invoiced, m.collected]),
      ['TOTAL', String(report.totals.invoiceCount), report.totals.invoiced, report.totals.collected],
    ];
    send(res, `revenue-${report.months[0]?.month ?? 'report'}.csv`, rows);
  }
}

/**
 * Quote a CSV field.
 *
 * A field starting with =, +, - or @ is prefixed with a single quote. Excel
 * and Google Sheets execute those as formulas, which turns an exported
 * customer name into a CSV injection vector (OWASP). Customer names are user
 * input and land directly in this file.
 */
function csvField(value: string): string {
  const risky = /^[=+\-@\t\r]/.test(value);
  const escaped = (risky ? `'${value}` : value).replace(/"/g, '""');
  return `"${escaped}"`;
}

function send(res: Response, fileName: string, rows: string[][]): void {
  // BOM so Excel opens UTF-8 correctly; without it, non-ASCII customer names
  // arrive mangled.
  const body = '﻿' + rows.map((r) => r.map(csvField).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(body);
}
