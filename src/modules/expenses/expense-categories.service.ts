import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AccessContext } from '../access-control/access-control.types';
import type {
  CreateExpenseCategoryDto,
  UpdateExpenseCategoryDto,
} from './dto/expense.dto';
import {
  expenseCategoryName,
  requireExpensePermission,
} from './expense.policy';
import { ExpenseCategoriesRepository } from './expense-categories.repository';

@Injectable()
export class ExpenseCategoriesService {
  constructor(private readonly repository: ExpenseCategoriesRepository) {}
  list(access: AccessContext) {
    requireExpensePermission(access, 'expenses.read');
    return this.repository.list();
  }
  create(input: CreateExpenseCategoryDto, access: AccessContext) {
    return this.save(null, input, access);
  }
  update(id: string, input: UpdateExpenseCategoryDto, access: AccessContext) {
    return this.save(id, input, access);
  }

  private async save(
    id: string | null,
    input: UpdateExpenseCategoryDto,
    access: AccessContext,
  ) {
    requireExpensePermission(access, 'expenses.categories_manage');
    const name =
      input.name === undefined ? undefined : expenseCategoryName(input.name);
    if (name === undefined && input.is_active === undefined)
      throw new BadRequestException('Provide a category change');
    try {
      return await this.repository.transaction(async (tx) => {
        const before = id ? await this.repository.lock(tx, id) : null;
        if (id && !before)
          throw new NotFoundException('Expense category not found');
        const after = id
          ? await this.repository.update(tx, id, {
              name,
              is_active: input.is_active,
            })
          : await this.repository.create(tx, name!);
        await this.repository.audit(tx, {
          actorUserId: access.userId,
          action: id ? 'expense_category.updated' : 'expense_category.created',
          entityType: 'expense_category',
          entityId: after.id,
          entityLabel: after.name,
          changes: {
            name: { from: before?.name ?? null, to: after.name },
            is_active: { from: before?.is_active ?? null, to: after.is_active },
          },
        });
        return after;
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException(
          'An expense category with this name already exists',
        );
      throw error;
    }
  }
}
