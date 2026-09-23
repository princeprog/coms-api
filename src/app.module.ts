import './config/load-env';

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
import { StockRequestsModule } from './modules/stock-requests/stock-requests.module';
import { DispatchesModule } from './modules/dispatches/dispatches.module';
import { RecipesModule } from './modules/recipes/recipes.module';
import { BranchProductsModule } from './modules/branch-products/branch-products.module';
import { SalesModule } from './modules/sales/sales.module';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
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
    StockRequestsModule,
    DispatchesModule,
    RecipesModule,
    BranchProductsModule,
    SalesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
