import { DirectPurchasesController } from './direct-purchases.controller';
import { DirectPurchasesService } from './direct-purchases.service';
import { DirectPurchasesRepository } from './direct-purchases.repository';
import { ReceiptPostingRepository } from './receipt-posting.repository';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExportsModule } from '../exports/exports.module';
import { ReceiptExportRepository } from './receipt-export.repository';
import { ReceiptExportService } from './receipt-export.service';
import { SupplierReceiptsController } from './supplier-receipts.controller';
import { SupplierReceiptsRepository } from './supplier-receipts.repository';
import { SupplierReceiptsService } from './supplier-receipts.service';

@Module({
  imports: [AuthModule, ExportsModule],
  controllers: [SupplierReceiptsController, DirectPurchasesController],
  providers: [
    SupplierReceiptsRepository,
    SupplierReceiptsService,
    ReceiptPostingRepository,
    DirectPurchasesService,
    DirectPurchasesRepository,
    ReceiptExportRepository,
    ReceiptExportService,
  ],
})
export class SupplierReceiptsModule {}
