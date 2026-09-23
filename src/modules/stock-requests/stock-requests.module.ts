import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StockRequestsController } from './stock-requests.controller';
import { StockRequestsRepository } from './stock-requests.repository';
import { StockRequestsService } from './stock-requests.service';

@Module({
  imports: [AuthModule],
  controllers: [StockRequestsController],
  providers: [StockRequestsRepository, StockRequestsService],
})
export class StockRequestsModule {}
