import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { loadServerEnv } from '@billing/config';

import { HealthController } from './health/health.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { OrganisationsController } from './organisations/organisations.controller.js';
import { CompaniesController } from './companies/companies.controller.js';
import { StockController } from './stock/stock.controller.js';
import { ReportsController } from './reports/reports.controller.js';
import { ReportsService } from './reports/reports.service.js';
import { StockService } from './stock/stock.service.js';
import { CustomersController } from './customers/customers.controller.js';
import { CustomersService } from './customers/customers.service.js';
import { QuotationsController } from './quotations/quotations.controller.js';
import { QuotationsService } from './quotations/quotations.service.js';
import { InvoicesController } from './invoices/invoices.controller.js';
import { InvoicesService } from './invoices/invoices.service.js';
import { PaymentsController } from './payments/payments.controller.js';
import { PaymentsService } from './payments/payments.service.js';
import { DashboardController } from './dashboard/dashboard.controller.js';
import { DashboardService } from './dashboard/dashboard.service.js';
import { SearchController } from './search/search.controller.js';
import { SearchService } from './search/search.service.js';
import { PdfService } from './documents/pdf.service.js';
import {
  PlaywrightPdfRenderer,
  BrowserlessPdfRenderer,
  type PdfRenderer,
} from './documents/pdf-renderer.js';
import { StorageService } from './documents/storage.service.js';

import { AuthGuard } from './common/guards/auth.guard.js';
import { OrganisationGuard } from './common/guards/organisation.guard.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware.js';
import { AuditService } from './common/audit/audit.service.js';
import { createLogger } from './common/logging/logger.js';

const env = loadServerEnv();

@Module({
  imports: [
    ThrottlerModule.forRoot([
      { name: 'default', ttl: env.RATE_LIMIT_WINDOW_MS, limit: env.RATE_LIMIT_MAX },
    ]),
  ],
  controllers: [
    HealthController,
    AuthController,
    OrganisationsController,
    CompaniesController,
    StockController,
    ReportsController,
    CustomersController,
    QuotationsController,
    InvoicesController,
    PaymentsController,
    SearchController,
    DashboardController,
  ],
  providers: [
    {
      provide: 'APP_LOGGER',
      useValue: createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development'),
    },
    AuditService,
    StockService,
    ReportsService,
    CustomersService,
    QuotationsService,
    InvoicesService,
    PaymentsService,
    SearchService,
    DashboardService,
    StorageService,
    /**
     * Chosen by configuration, not by NODE_ENV.
     *
     * A serverless deployment cannot run Chromium, so it must have a remote
     * renderer; a container host may legitimately use either. Keying on
     * BROWSERLESS_TOKEN lets the same production build do both, and the throw
     * below turns a missing token into a startup failure rather than a 500 on
     * the first download a customer attempts.
     */
    {
      provide: 'PDF_RENDERER',
      useFactory: (): PdfRenderer => {
        if (env.PDF_RENDERER === 'browserless') {
          if (!env.BROWSERLESS_TOKEN) {
            throw new Error(
              'PDF_RENDERER=browserless requires BROWSERLESS_TOKEN to be set',
            );
          }
          return new BrowserlessPdfRenderer(
            env.BROWSERLESS_ENDPOINT,
            env.BROWSERLESS_TOKEN,
            env.PDF_RENDER_TIMEOUT_MS,
          );
        }
        return new PlaywrightPdfRenderer();
      },
    },
    PdfService,

    // Guard order matters and is guaranteed by registration order:
    //   throttle -> authenticate -> organisation membership + role.
    // Each later guard depends on state the earlier one attached.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: OrganisationGuard },

    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
