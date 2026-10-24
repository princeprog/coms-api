import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { AccessContext } from '../access-control/access-control.types';
import type { PermissionKey } from '../access-control/permission-catalog';
import type { CreateExpenseDto, ExpenseQueryDto } from './dto/expense.dto';
import type {
  ExpenseAccess,
  ExpenseInput,
  ExpenseLocation,
  ExpenseRecord,
} from './expense.types';

export function hasExpensePermission(
  access: AccessContext,
  permission: PermissionKey,
) {
  return (
    access.accountActive &&
    !!access.role?.isActive &&
    ((access.role.isSystem && access.role.code === 'SUPER_ADMIN') ||
      access.permissions.includes(permission))
  );
}

export function requireExpensePermission(
  access: AccessContext,
  permission: PermissionKey,
) {
  if (!hasExpensePermission(access, permission))
    throw new ForbiddenException('Permission required');
}

export function assertExpenseLocation(
  location: ExpenseLocation,
  access: ExpenseAccess,
) {
  if (
    location.scope === 'COMMISSARY'
      ? !access.commissary
      : !location.branch_id ||
        (access.branchIds !== null &&
          !access.branchIds.includes(location.branch_id))
  ) {
    throw new ForbiddenException('Expense location access required');
  }
}

export function manilaDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function assertExpenseDate(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new BadRequestException('Enter a valid calendar date');
}

export function expenseRange(
  query: Pick<ExpenseQueryDto, 'from' | 'to'>,
  now = new Date(),
) {
  const today = manilaDate(now);
  const from = query.from ?? `${today.slice(0, 7)}-01`;
  const monthEnd = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  monthEnd.setUTCDate(0);
  const to = query.to ?? monthEnd.toISOString().slice(0, 10);
  assertExpenseDate(from);
  assertExpenseDate(to);
  if (from > to)
    throw new BadRequestException('The start date must be before the end date');
  return { from, to };
}

export function canonicalAmount(value: string) {
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(value))
    throw new BadRequestException(
      'Enter an amount with at most two decimal places',
    );
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n || cents > 99999999999n)
    throw new BadRequestException(
      'Amount must be between 0.01 and 999999999.99',
    );
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export function canonicalExpense(input: CreateExpenseDto): ExpenseInput {
  assertExpenseDate(input.expense_date);
  if (input.expense_date > manilaDate())
    throw new BadRequestException('Expense date cannot be in the future');
  const value: ExpenseInput = {
    expense_date: input.expense_date,
    scope: input.scope,
    branch_id: input.branch_id?.toLowerCase() ?? null,
    category_id: input.category_id.toLowerCase(),
    description: input.description.trim(),
    amount: canonicalAmount(input.amount.trim()),
    payment_method: input.payment_method,
    cash_source: input.cash_source ?? null,
    cash_movement_id: input.cash_movement_id?.toLowerCase() ?? null,
    payee: input.payee?.trim() || null,
    reference: input.reference?.trim() || null,
    notes: input.notes?.trim() || null,
  };
  if ((value.scope === 'BRANCH') !== !!value.branch_id)
    throw new BadRequestException('Select a branch only for a branch expense');
  if (value.payment_method !== 'CASH') {
    if (value.cash_source || value.cash_movement_id)
      throw new BadRequestException(
        'Non-cash expenses cannot link register cash',
      );
  } else if (
    !value.cash_source ||
    (value.cash_source === 'REGISTER'
      ? value.scope !== 'BRANCH' || !value.cash_movement_id
      : !!value.cash_movement_id)
  ) {
    throw new BadRequestException(
      'Choose a valid cash source and register cash-out',
    );
  }
  return value;
}

export function expenseIdempotencyKey(key?: string) {
  if (!key || !isUUID(key))
    throw new BadRequestException('A UUID Idempotency-Key header is required');
  return key.toLowerCase();
}

export function assertEditableExpense(record: ExpenseRecord, revision: number) {
  if (record.status !== 'RECORDED')
    throw new ConflictException('Voided expenses cannot be changed');
  if (record.revision !== revision)
    throw new ConflictException(
      'This expense changed. Refresh it before trying again',
    );
}

export function assertLinkedExpenseUnchanged(
  before: ExpenseRecord,
  after: ExpenseInput,
) {
  if (!before.cash_movement_id) return;
  const immutable = [
    'scope',
    'branch_id',
    'payment_method',
    'cash_source',
    'cash_movement_id',
  ] as const;
  if (
    immutable.some((key) => before[key] !== after[key]) ||
    canonicalAmount(before.amount) !== after.amount
  )
    throw new ConflictException(
      'Void and recreate this expense to change its register link, location, payment or amount',
    );
}

export function expenseCategoryName(name: string) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80)
    throw new BadRequestException('Enter a category name of 1–80 characters');
  if (trimmed.toLowerCase() === 'stock purchases')
    throw new BadRequestException('Stock purchases is a reserved category');
  return trimmed;
}
