import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import type { Transaction } from 'kysely';
import type { DB } from '../../database/db';
import type { AccessContext } from '../access-control/access-control.types';
import type {
  CreateExpenseDto,
  UpdateExpenseDto,
  VoidExpenseDto,
} from './dto/expense.dto';
import {
  assertEditableExpense,
  assertLinkedExpenseUnchanged,
  canonicalAmount,
  canonicalExpense,
  expenseIdempotencyKey,
  hasExpensePermission,
  requireExpensePermission,
} from './expense.policy';
import { ExpensesAccessService } from './expenses-access.service';
import { ExpensesReadRepository } from './expenses-read.repository';
import { ExpensesRepository } from './expenses.repository';
import type {
  ExpenseAccess,
  ExpenseDetail,
  ExpenseInput,
  ExpenseRecord,
} from './expense.types';

@Injectable()
export class ExpenseMutationsService {
  constructor(
    private readonly repository: ExpensesRepository,
    private readonly reads: ExpensesReadRepository,
    private readonly accessPolicy: ExpensesAccessService,
  ) {}

  create(input: CreateExpenseDto, access: AccessContext, key?: string) {
    requireExpensePermission(access, 'expenses.create');
    const value = canonicalExpense(input);
    return this.mutate(
      'CREATED',
      null,
      value,
      null,
      null,
      access,
      expenseIdempotencyKey(key),
    );
  }

  update(
    id: string,
    input: UpdateExpenseDto,
    access: AccessContext,
    key?: string,
  ) {
    requireExpensePermission(access, 'expenses.update');
    return this.mutate(
      'UPDATED',
      id.toLowerCase(),
      canonicalExpense(input),
      input.revision,
      input.reason.trim(),
      access,
      expenseIdempotencyKey(key),
    );
  }

  void(id: string, input: VoidExpenseDto, access: AccessContext, key?: string) {
    requireExpensePermission(access, 'expenses.void');
    return this.mutate(
      'VOIDED',
      id.toLowerCase(),
      null,
      input.revision,
      input.reason.trim(),
      access,
      expenseIdempotencyKey(key),
    );
  }

  private async mutate(
    action: 'CREATED' | 'UPDATED' | 'VOIDED',
    id: string | null,
    value: ExpenseInput | null,
    revision: number | null,
    reason: string | null,
    access: AccessContext,
    key: string,
  ): Promise<ExpenseDetail> {
    const scope = await this.accessPolicy.resolve(access);
    if (value) this.accessPolicy.assert(value, scope);
    const payload = {
      action,
      expense_id: id,
      actor_user_id: access.userId,
      input: value,
      revision,
      reason,
    };
    try {
      return await this.repository.transaction(async (tx) => {
        const retry = await this.repository.lockRequest(tx, key);
        if (retry) {
          if (
            retry.actor_user_id !== access.userId ||
            !isDeepStrictEqual(retry.request_payload, payload)
          )
            throw new ConflictException(
              'This idempotency key was already used for a different request',
            );
          if (retry.before_values)
            this.accessPolicy.assert(retry.before_values, scope);
          this.accessPolicy.assert(retry.after_values, scope);
          return this.detail(tx, retry.expense_id, scope);
        }

        let before: ExpenseRecord | null = null;
        if (id) {
          await this.repository.lockExpense(tx, id);
          before = (await this.detail(tx, id, scope)).record;
          this.accessPolicy.assert(before, scope);
          assertEditableExpense(before, revision!);
        }
        if (value) {
          if (before) assertLinkedExpenseUnchanged(before, value);
          await this.validateReferences(tx, value, before, access);
        }
        let expenseId = id;
        if (action === 'CREATED')
          expenseId = (await this.repository.insert(tx, value!, access.userId))
            .id;
        else if (action === 'UPDATED')
          await this.repository.update(tx, id!, value!, access.userId);
        else await this.repository.void(tx, id!, access.userId);

        const after = (await this.detail(tx, expenseId!, scope)).record;
        await this.repository.event(tx, {
          action,
          key,
          payload,
          reason,
          userId: access.userId,
          before,
          after,
        });
        const changes = Object.fromEntries(
          Object.keys(after)
            .filter((field) => {
              const name = field as keyof ExpenseRecord;
              return before?.[name] !== after[name];
            })
            .map((field) => {
              const name = field as keyof ExpenseRecord;
              return [field, { from: before?.[name] ?? null, to: after[name] }];
            }),
        );
        await this.repository.audit(tx, {
          actorUserId: access.userId,
          action: `expense.${action.toLowerCase()}`,
          entityType: 'expense',
          entityId: after.id,
          entityLabel: after.description,
          branchId: after.branch_id,
          changes,
          metadata: {
            reason,
            source: 'OPERATING',
            previous_branch_id: before?.branch_id ?? null,
          },
        });
        return this.detail(tx, expenseId!, scope);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException(
          'This cash-out is already linked to a recorded expense',
        );
      throw error;
    }
  }

  private async detail(
    tx: Transaction<DB>,
    id: string,
    scope: ExpenseAccess,
  ): Promise<ExpenseDetail> {
    const result = await this.reads.detail('OPERATING', id, scope, tx);
    if (!result) throw new NotFoundException('Expense not found');
    return { ...result, source_href: null };
  }

  private async validateReferences(
    tx: Transaction<DB>,
    value: ExpenseInput,
    before: ExpenseRecord | null,
    access: AccessContext,
  ) {
    const category = await this.repository.category(tx, value.category_id);
    if (
      !category ||
      (!category.is_active && before?.category_id !== value.category_id)
    )
      throw new BadRequestException('Select an active expense category');
    if (value.branch_id) {
      const branch = await this.repository.branch(tx, value.branch_id);
      if (
        !branch ||
        (branch.status !== 'active' &&
          (before?.scope !== value.scope ||
            before?.branch_id !== value.branch_id))
      )
        throw new BadRequestException('Select an active expense location');
    }
    if (
      !value.cash_movement_id ||
      before?.cash_movement_id === value.cash_movement_id
    )
      return;
    requireExpensePermission(access, 'shifts.read');
    const movement = await this.repository.cashMovement(
      tx,
      value.cash_movement_id,
    );
    if (
      !movement ||
      movement.direction !== 'OUT' ||
      movement.branch_id !== value.branch_id
    )
      throw new BadRequestException('Select a cash-out from this branch');
    if (
      movement.opened_by_user_id !== access.userId &&
      !hasExpensePermission(access, 'shifts.review')
    )
      throw new ForbiddenException(
        'Only the shift owner or a shift reviewer can link this cash-out',
      );
    if (canonicalAmount(movement.amount) !== value.amount)
      throw new BadRequestException(
        'The expense amount must match the cash-out exactly',
      );
    if (await this.repository.activeCashLink(tx, movement.id))
      throw new ConflictException(
        'This cash-out is already linked to a recorded expense',
      );
  }
}
