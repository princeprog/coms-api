import { DirectPurchasesController } from './direct-purchases.controller';
import { DirectPurchasesService } from './direct-purchases.service';
import { DirectPurchasesRepository } from './direct-purchases.repository';
import { ReceiptPostingRepository } from './receipt-posting.repository';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SupplierReceiptsController } from './supplier-receipts.controller';
import { SupplierReceiptsRepository } from './supplier-receipts.repository';
import { SupplierReceiptsService } from './supplier-receipts.service';

@Module({
  imports: [AuthModule],
  controllers: [SupplierReceiptsController, DirectPurchasesController],
  providers: [
    SupplierReceiptsRepository,
    SupplierReceiptsService,
    ReceiptPostingRepository,
    DirectPurchasesService,
    DirectPurchasesRepository,
  ],
})
export class SupplierReceiptsModule {}
