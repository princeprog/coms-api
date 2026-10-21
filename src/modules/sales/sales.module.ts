import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExportsModule } from '../exports/exports.module';
import { SalesController } from './sales.controller';
import { SalesExportService } from './sales-export.service';
import { SalesRepository } from './sales.repository';
import { SalesService } from './sales.service';

@Module({
  imports: [AuthModule, ExportsModule],
  controllers: [SalesController],
  providers: [SalesRepository, SalesService, SalesExportService],
})
export class SalesModule {}
