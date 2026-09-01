import { Controller, Get, Query, Res, Inject } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { OrganisationContext } from '@billing/types';
import { zodPipe } from '../common/pipes/zod-validation.pipe.js';
import { CurrentOrganisation } from '../common/decorators/current-context.decorator.js';
import { RequirePermission } from '../common/decorators/require-permission.decorator.js';
import { ReportsService } from './reports.service.js';

/** YYYY-MM-DD, as sent by a native date input. */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a real date');

const revenueQuerySchema = z
  .object({
    /** Fallback when no explicit range is given: months back, inclusive. */
    months: z.coerce.number().int().min(1).max(36).default(12),
    from: dateOnly.optional(),
    to: dateOnly.optional(),
  })
  .refine((q) => !(q.from && q.to) || q.from <= q.to, {
    message: 'The start date must be on or before the end date',
    path: ['from'],
  });

type RevenueQuery = z.infer<typeof revenueQuerySchema>;

/** Parsed at UTC midnight to match how due dates and month boundaries are stored. */
const toUtcDate = (value?: string) => (value ? new Date(`${value}T00:00:00Z`) : undefined);

const rangeOf = (q: RevenueQuery) => ({
  months: q.months,
  from: toUtcDate(q.from),
  to: toUtcDate(q.to),
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
    @Query(zodPipe(revenueQuerySchema)) query: RevenueQuery,
  ) {
    return this.reports.revenue(org, rangeOf(query));
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
    @Query(zodPipe(revenueQuerySchema)) query: RevenueQuery,
    @Res() res: Response,
  ) {
    const report = await this.reports.revenue(org, rangeOf(query));
    const rows = [
      ['Month', 'Invoices', 'Invoiced', 'Collected'],
      ...report.months.map((m) => [m.month, String(m.invoiceCount), m.invoiced, m.collected]),
      ['TOTAL', String(report.totals.invoiceCount), report.totals.invoiced, report.totals.collected],
    ];
    // Name the file after the range it covers, so several downloads do not
    // all land in the same folder as "revenue.csv".
    send(res, `revenue-${report.from || 'report'}-to-${report.to || ''}.csv`, rows);
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
