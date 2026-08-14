import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { loadServerEnv } from '@billing/config';

import { HealthController } from './health/health.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { OrganisationsController } from './organisations/organisations.controller.js';
import { CustomersController } from './customers/customers.controller.js';
import { CustomersService } from './customers/customers.service.js';
import { QuotationsController } from './quotations/quotations.controller.js';
import { QuotationsService } from './quotations/quotations.service.js';
import { PdfService } from './documents/pdf.service.js';
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
    CustomersController,
    QuotationsController,
  ],
  providers: [
    {
      provide: 'APP_LOGGER',
      useValue: createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development'),
    },
    AuditService,
    CustomersService,
    QuotationsService,
    StorageService,
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
