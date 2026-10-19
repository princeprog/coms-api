import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductCategoriesController } from './product-categories.controller';
import { ProductCategoriesService } from './product-categories.service';
import { ProductCategoriesRepository } from './product-categories.repository';
@Module({
  imports: [AuthModule],
  controllers: [ProductCategoriesController],
  providers: [ProductCategoriesService, ProductCategoriesRepository],
})
export class ProductCategoriesModule {}
