import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExportsModule } from '../exports/exports.module';
import { InventoryController } from './inventory.controller';
import { InventoryExportService } from './inventory-export.service';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';

@Module({
  imports: [AuthModule, ExportsModule],
  controllers: [InventoryController],
  providers: [InventoryRepository, InventoryService, InventoryExportService],
})
export class InventoryModule {}
