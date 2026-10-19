import './config/load-env';
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

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    PaymentMethodsModule,
    ProductCategoriesModule,
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    ObserveModule.forRoot({
      appKey: 'YOUR_APP_KEY',
      appSecret: 'YOUR_APP_SECRET',
      serviceId: 'coms-api',
    }),
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
