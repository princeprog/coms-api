import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExportsModule } from '../exports/exports.module';
import { InventoryController } from './inventory.controller';
import { InventoryExportService } from './inventory-export.service';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';
import { StockLevelsRepository } from './stock-levels.repository';
import { StockLevelsService } from './stock-levels.service';

@Module({
  imports: [AuthModule, ExportsModule],
  controllers: [InventoryController],
  providers: [
    InventoryRepository,
    InventoryService,
    InventoryExportService,
    StockLevelsRepository,
    StockLevelsService,
  ],
})
export class InventoryModule {}
