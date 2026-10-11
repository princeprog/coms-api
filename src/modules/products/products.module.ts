import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsController } from './products.controller';
import { ProductsRepository } from './products.repository';
import { ProductsService } from './products.service';
import { ProductSetupController } from './product-setup.controller';
import { ProductSetupService } from './product-setup.service';
import { ProductSetupRepository } from './product-setup.repository';

@Module({
  imports: [AuthModule],
  controllers: [ProductSetupController, ProductsController],
  providers: [
    ProductsRepository,
    ProductsService,
    ProductSetupRepository,
    ProductSetupService,
  ],
})
export class ProductsModule {}
