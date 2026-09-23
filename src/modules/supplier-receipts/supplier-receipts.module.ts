import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SupplierReceiptsController } from './supplier-receipts.controller';
import { SupplierReceiptsRepository } from './supplier-receipts.repository';
import { SupplierReceiptsService } from './supplier-receipts.service';

@Module({
  imports: [AuthModule],
  controllers: [SupplierReceiptsController],
  providers: [SupplierReceiptsRepository, SupplierReceiptsService],
})
export class SupplierReceiptsModule {}
