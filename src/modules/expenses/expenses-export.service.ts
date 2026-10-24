import { Injectable } from '@nestjs/common';
import type { AccessContext } from '../access-control/access-control.types';
import { CsvExportService, exportPage } from '../exports/csv-export.service';
import type { ExpenseQueryDto } from './dto/expense.dto';
import { ExpensesService } from './expenses.service';
import { expenseRange } from './expense.policy';

@Injectable()
export class ExpensesExportService {
  constructor(
    private readonly expenses: ExpensesService,
    private readonly csv: CsvExportService,
  ) {}
  async export(query: ExpenseQueryDto, access: AccessContext) {
    const filters = { ...query, ...expenseRange(query) };
    const result = await this.expenses.list(
      { ...filters, ...exportPage },
      access,
    );
    return this.csv.file({
      label: 'Expenses',
      nameParts: ['expenses', this.csv.range(filters.from, filters.to)],
      filters,
      branchId: query.branch_id,
      total: result.total,
      rows: result.items,
      columns: [
        { header: 'Date', value: (row) => row.expense_date },
        { header: 'Source', value: (row) => row.source },
        { header: 'Location', value: (row) => row.location_name },
        { header: 'Scope', value: (row) => row.scope },
        { header: 'Category', value: (row) => row.category_name },
        { header: 'Description', value: (row) => row.description },
        { header: 'Amount (PHP)', value: (row) => row.amount },
        { header: 'Payment method', value: (row) => row.payment_method },
        { header: 'Cash source', value: (row) => row.cash_source },
        { header: 'Cash movement ID', value: (row) => row.cash_movement_id },
        { header: 'Payee', value: (row) => row.payee },
        { header: 'Reference', value: (row) => row.reference },
        { header: 'Notes', value: (row) => row.notes },
        { header: 'Status', value: (row) => row.status },
        { header: 'Recorded by', value: (row) => row.created_by_name },
        { header: 'Created at', value: (row) => new Date(row.created_at) },
        { header: 'Updated at', value: (row) => new Date(row.updated_at) },
      ],
    });
  }
}
