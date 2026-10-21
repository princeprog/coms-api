import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExportsModule } from '../exports/exports.module';
import { CostsController } from './costs.controller';
import { CostsExportService } from './costs-export.service';
import { CostsRepository } from './costs.repository';
import { CostsService } from './costs.service';

@Module({
  imports: [AuthModule, ExportsModule],
  controllers: [CostsController],
  providers: [CostsRepository, CostsService, CostsExportService],
  exports: [CostsService],
})
export class CostsModule {}
