import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { AccessContext } from '../access-control/access-control.types';
import type { CashOutQueryDto, ExpenseQueryDto } from './dto/expense.dto';
import {
  expenseRange,
  hasExpensePermission,
  requireExpensePermission,
} from './expense.policy';
import { ExpensesAccessService } from './expenses-access.service';
import { ExpensesReadRepository } from './expenses-read.repository';
import { ExpensesRepository } from './expenses.repository';
import type { ExpenseSource } from './expense.types';

@Injectable()
export class ExpensesService {
  constructor(
    private readonly reads: ExpensesReadRepository,
    private readonly repository: ExpensesRepository,
    private readonly accessPolicy: ExpensesAccessService,
  ) {}

  async list(query: ExpenseQueryDto, access: AccessContext) {
    requireExpensePermission(access, 'expenses.read');
    const filters = { ...query, ...expenseRange(query) };
    if (
      query.category_id &&
      query.category_id !== 'STOCK_PURCHASES' &&
      !isUUID(query.category_id)
    )
      throw new BadRequestException('Select a valid expense category');
    if (query.scope === 'COMMISSARY' && query.branch_id)
      throw new BadRequestException(
        'Commissary filters cannot include a branch',
      );
    const scope = await this.accessPolicy.resolve(access);
    if (query.scope === 'COMMISSARY')
      this.accessPolicy.assert({ scope: 'COMMISSARY', branch_id: null }, scope);
    if (query.branch_id)
      this.accessPolicy.assert(
        { scope: 'BRANCH', branch_id: query.branch_id.toLowerCase() },
        scope,
      );
    if (filters.category_id && filters.category_id !== 'STOCK_PURCHASES')
      filters.category_id = filters.category_id.toLowerCase();
    return this.reads.list(filters, scope);
  }

  async detail(source: string, id: string, access: AccessContext) {
    requireExpensePermission(access, 'expenses.read');
    if (!['OPERATING', 'SUPPLIER_DELIVERY', 'DIRECT_PURCHASE'].includes(source))
      throw new BadRequestException('Unknown expense source');
    const result = await this.reads.detail(
      source as ExpenseSource,
      id,
      await this.accessPolicy.resolve(access),
    );
    if (!result) throw new NotFoundException('Expense not found');
    return {
      ...result,
      source_href:
        source !== 'OPERATING' &&
        hasExpensePermission(access, 'supplier_receipts.read')
          ? source === 'SUPPLIER_DELIVERY'
            ? `/receipts/${id}`
            : `/inventory/purchases?purchase_id=${id}`
          : null,
    };
  }

  async locations(access: AccessContext) {
    requireExpensePermission(access, 'expenses.read');
    return this.repository.locations(await this.accessPolicy.resolve(access));
  }

  async cashOuts(query: CashOutQueryDto, access: AccessContext) {
    requireExpensePermission(access, 'expenses.read');
    requireExpensePermission(access, 'shifts.read');
    this.accessPolicy.assert(
      { scope: 'BRANCH', branch_id: query.branch_id.toLowerCase() },
      await this.accessPolicy.resolve(access),
    );
    return this.repository.cashOuts(
      query,
      access.userId,
      hasExpensePermission(access, 'shifts.review'),
    );
  }
}
