import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StockItemsController } from './stock-items.controller';
import { StockItemsRepository } from './stock-items.repository';
import { StockItemsService } from './stock-items.service';

@Module({
  imports: [AuthModule],
  controllers: [StockItemsController],
  providers: [StockItemsRepository, StockItemsService],
})
export class StockItemsModule {}
