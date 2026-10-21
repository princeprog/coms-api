import { Module } from '@nestjs/common';
import { CsvExportService } from './csv-export.service';

@Module({
  providers: [CsvExportService],
  exports: [CsvExportService],
})
export class ExportsModule {}
