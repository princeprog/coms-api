import './config/load-env';
import { BusinessDayModule } from './modules/business-day/business-day.module';
import { ShiftsModule } from './modules/shifts/shifts.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ProductCategoriesModule } from './modules/product-categories/product-categories.module';
import { PaymentMethodsModule } from './modules/payment-methods/payment-methods.module';

import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { RolesModule } from './modules/roles/roles.module';
import { BranchesModule } from './modules/branches/branches.module';
import { StaffModule } from './modules/staff/staff.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { StockItemsModule } from './modules/stock-items/stock-items.module';
import { ProductsModule } from './modules/products/products.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { SupplierReceiptsModule } from './modules/supplier-receipts/supplier-receipts.module';
import { DispatchesModule } from './modules/dispatches/dispatches.module';
import { BranchProductsModule } from './modules/branch-products/branch-products.module';
import { SalesModule } from './modules/sales/sales.module';
import { DailyReportsModule } from './modules/daily-reports/daily-reports.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { CostsModule } from './modules/costs/costs.module';
import { AuditModule } from './modules/audit/audit.module';
import { SalesReportModule } from './modules/sales-report/sales-report.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditContextInterceptor } from './common/interceptors/audit-context.interceptor';

const observeKey = process.env.NEST_OBSERVE_APP_KEY;
const observeSecret = process.env.NEST_OBSERVE_APP_SECRET;
const observe = observeKey && observeSecret ? createObserveModule() : undefined;
export const ObserveInstrument = observe?.ObserveInstrument;

@Module({
  imports: [
    BusinessDayModule,
    ShiftsModule,
    NotificationsModule,
    PaymentMethodsModule,
    ProductCategoriesModule,
    ...(observe && observeKey && observeSecret
      ? [
          observe.ObserveModule.forRoot({
            appKey: observeKey,
            appSecret: observeSecret,
            serviceId: 'coms-api',
          }),
        ]
      : []),
    AuthModule,
    RolesModule,
    BranchesModule,
    StaffModule,
    SuppliersModule,
    StockItemsModule,
    ProductsModule,
    InventoryModule,
    SupplierReceiptsModule,
    DispatchesModule,
    BranchProductsModule,
    SalesModule,
    DailyReportsModule,
    DashboardModule,
    CostsModule,
    AuditModule,
    SalesReportModule,
    ExpensesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_INTERCEPTOR, useClass: AuditContextInterceptor },
  ],
})
export class AppModule {}
