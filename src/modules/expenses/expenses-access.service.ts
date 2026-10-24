import { Injectable } from '@nestjs/common';
import type { AccessContext } from '../access-control/access-control.types';
import { assertExpenseLocation, hasExpensePermission } from './expense.policy';
import { ExpensesRepository } from './expenses.repository';
import type { ExpenseAccess, ExpenseLocation } from './expense.types';

@Injectable()
export class ExpensesAccessService {
  constructor(private readonly repository: ExpensesRepository) {}

  async resolve(access: AccessContext): Promise<ExpenseAccess> {
    return {
      commissary: hasExpensePermission(access, 'expenses.commissary_read'),
      branchIds: hasExpensePermission(access, 'expenses.global_read')
        ? null
        : await this.repository.assignedBranches(access.userId),
    };
  }

  assert(location: ExpenseLocation, scope: ExpenseAccess) {
    assertExpenseLocation(location, scope);
  }
}
