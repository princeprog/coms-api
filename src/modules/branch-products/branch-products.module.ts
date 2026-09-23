import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BranchProductsController } from './branch-products.controller';
import { BranchProductsRepository } from './branch-products.repository';
import { BranchProductsService } from './branch-products.service';

@Module({
  imports: [AuthModule],
  controllers: [BranchProductsController],
  providers: [BranchProductsRepository, BranchProductsService],
})
export class BranchProductsModule {}
