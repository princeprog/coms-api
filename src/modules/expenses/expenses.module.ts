import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExportsModule } from '../exports/exports.module';
import { ExpenseCategoriesRepository } from './expense-categories.repository';
import { ExpenseCategoriesService } from './expense-categories.service';
import { ExpenseMutationsService } from './expense-mutations.service';
import { ExpensesAccessService } from './expenses-access.service';
import { ExpensesExportService } from './expenses-export.service';
import { ExpensesReadRepository } from './expenses-read.repository';
import { ExpensesController } from './expenses.controller';
import { ExpensesRepository } from './expenses.repository';
import { ExpensesService } from './expenses.service';

@Module({
  imports: [AuthModule, ExportsModule],
  controllers: [ExpensesController],
  providers: [
    ExpensesService,
    ExpensesRepository,
    ExpensesReadRepository,
    ExpensesAccessService,
    ExpenseMutationsService,
    ExpenseCategoriesService,
    ExpenseCategoriesRepository,
    ExpensesExportService,
  ],
})
export class ExpensesModule {}
