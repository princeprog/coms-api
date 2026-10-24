import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import type { AccessContext } from '../access-control/access-control.types';
import {
  CreateExpenseDto,
  ExpenseQueryDto,
  UpdateExpenseCategoryDto,
  UpdateExpenseDto,
} from './dto/expense.dto';
import {
  assertEditableExpense,
  assertExpenseLocation,
  assertLinkedExpenseUnchanged,
  canonicalAmount,
  canonicalExpense,
  expenseCategoryName,
  expenseIdempotencyKey,
  expenseRange,
  hasExpensePermission,
  manilaDate,
} from './expense.policy';
import type { ExpenseRecord } from './expense.types';

const branchId = '2cdb6691-e378-4752-9362-1b9b29e33338';
const categoryId = '49cd76b9-adab-463d-9de4-095db77dfc63';
const movementId = 'c77668c9-1ec4-436b-8f4e-c2140ca9881a';
const input: CreateExpenseDto = {
  expense_date: '2026-01-01',
  scope: 'BRANCH',
  branch_id: branchId,
  category_id: categoryId,
  description: 'Fuel',
  amount: '12.30',
  payment_method: 'CASH',
  cash_source: 'REGISTER',
  cash_movement_id: movementId,
};
const record: ExpenseRecord = {
  ...canonicalExpense(input),
  id: categoryId,
  source: 'OPERATING',
  status: 'RECORDED',
  revision: 1,
  location_name: 'Main branch',
  category_name: 'Transportation',
  created_by_user_id: branchId,
  created_by_name: 'Staff',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('expense money and mutation policy', () => {
  it.each([
    ['0.01', '0.01'],
    ['0001.2', '1.20'],
    ['999999999.99', '999999999.99'],
    ['1', '1.00'],
  ])('canonicalizes %s without floating point', (value, expected) => {
    expect(canonicalAmount(value)).toBe(expected);
  });
  it.each(['0', '0.00', '-1', '1.001', '1e2', '1000000000', 'NaN', '.5'])(
    'rejects invalid money %s',
    (value) => {
      expect(() => canonicalAmount(value)).toThrow(BadRequestException);
    },
  );
  it('persists a canonical representation for optional fields, identifiers and amount', () => {
    expect(
      canonicalExpense({
        ...input,
        category_id: categoryId.toUpperCase(),
        description: ' Fuel ',
        amount: '0012.3',
        payee: ' ',
        reference: null,
      }),
    ).toEqual(canonicalExpense(input));
  });
  it.each([
    { payment_method: 'CARD' as const },
    { scope: 'COMMISSARY' as const },
    { cash_movement_id: null },
    { cash_source: 'OTHER' as const },
    { branch_id: null },
  ])('rejects inconsistent location or cash combinations %j', (change) => {
    expect(() => canonicalExpense({ ...input, ...change })).toThrow(
      BadRequestException,
    );
  });
  it('allows cash from outside the register and non-cash without a register link', () => {
    expect(
      canonicalExpense({
        ...input,
        cash_source: 'OTHER',
        cash_movement_id: null,
      }).cash_movement_id,
    ).toBeNull();
    expect(
      canonicalExpense({
        ...input,
        payment_method: 'CARD',
        cash_source: null,
        cash_movement_id: null,
      }).cash_source,
    ).toBeNull();
  });
  it.each([
    { scope: 'COMMISSARY' as const, branch_id: null },
    { branch_id: categoryId },
    { amount: '12.31' },
    { cash_movement_id: categoryId },
    { payment_method: 'OTHER' as const },
    { cash_source: 'OTHER' as const },
  ])(
    'keeps linked location, cash and payment fields immutable %j',
    (change) => {
      expect(() =>
        assertLinkedExpenseUnchanged(record, {
          ...canonicalExpense(input),
          ...change,
        }),
      ).toThrow(ConflictException);
    },
  );
  it('allows linked history corrections and new links on unlinked expenses', () => {
    expect(() =>
      assertLinkedExpenseUnchanged(record, {
        ...canonicalExpense(input),
        description: 'Corrected payee',
      }),
    ).not.toThrow();
    expect(() =>
      assertLinkedExpenseUnchanged(
        { ...record, cash_movement_id: null },
        canonicalExpense(input),
      ),
    ).not.toThrow();
  });
  it('rejects stale revisions and all writes to voided records', () => {
    expect(() => assertEditableExpense(record, 2)).toThrow(ConflictException);
    expect(() =>
      assertEditableExpense({ ...record, status: 'VOIDED' }, 1),
    ).toThrow(ConflictException);
    expect(() => assertEditableExpense(record, 1)).not.toThrow();
  });
  it('validates and canonicalizes idempotency keys', () => {
    expect(expenseIdempotencyKey(movementId.toUpperCase())).toBe(movementId);
    expect(() => expenseIdempotencyKey()).toThrow(BadRequestException);
    expect(() => expenseIdempotencyKey('retry')).toThrow(BadRequestException);
  });
});

describe('expense access policy', () => {
  const access: AccessContext = {
    userId: branchId,
    accountActive: true,
    role: {
      id: categoryId,
      code: 'CUSTOM',
      name: 'Reader',
      isSystem: false,
      isActive: true,
    },
    permissions: ['expenses.read', 'expenses.global_read'],
    branchIds: [],
  };
  it('does not infer mutations or commissary access from global read', () => {
    expect(hasExpensePermission(access, 'expenses.global_read')).toBe(true);
    expect(hasExpensePermission(access, 'expenses.create')).toBe(false);
    expect(hasExpensePermission(access, 'expenses.commissary_read')).toBe(
      false,
    );
    expect(() =>
      assertExpenseLocation(
        { scope: 'COMMISSARY', branch_id: null },
        { commissary: false, branchIds: null },
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertExpenseLocation(
        { scope: 'BRANCH', branch_id: branchId },
        { commissary: false, branchIds: null },
      ),
    ).not.toThrow();
  });
  it('requires a branch assignment independently of commissary access', () => {
    expect(() =>
      assertExpenseLocation(
        { scope: 'BRANCH', branch_id: branchId },
        { commissary: true, branchIds: [] },
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      assertExpenseLocation(
        { scope: 'BRANCH', branch_id: branchId },
        { commissary: false, branchIds: [branchId] },
      ),
    ).not.toThrow();
  });
  it('only grants the Super Admin bypass to active accounts with the active system role', () => {
    const admin = {
      ...access,
      role: { ...access.role!, code: 'SUPER_ADMIN', isSystem: true },
    };
    expect(hasExpensePermission(admin, 'expenses.void')).toBe(true);
    expect(
      hasExpensePermission({ ...admin, accountActive: false }, 'expenses.void'),
    ).toBe(false);
    expect(
      hasExpensePermission(
        { ...admin, role: { ...admin.role, isActive: false } },
        'expenses.void',
      ),
    ).toBe(false);
    expect(
      hasExpensePermission(
        { ...admin, role: { ...admin.role, isSystem: false } },
        'expenses.void',
      ),
    ).toBe(false);
    expect(
      hasExpensePermission({ ...access, role: null }, 'expenses.read'),
    ).toBe(false);
  });
});

describe('expense input boundaries', () => {
  it('defaults to the Manila calendar month, including the UTC month boundary', () => {
    const instant = new Date('2026-01-31T16:01:00Z');
    expect(manilaDate(instant)).toBe('2026-02-01');
    expect(expenseRange({}, instant)).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(expenseRange({}, new Date('2028-02-15T00:00:00Z')).to).toBe(
      '2028-02-29',
    );
  });
  it('rejects impossible dates, future spending and reversed ranges', () => {
    expect(() =>
      canonicalExpense({ ...input, expense_date: '2026-02-30' }),
    ).toThrow(BadRequestException);
    expect(() =>
      canonicalExpense({ ...input, expense_date: '9999-01-01' }),
    ).toThrow(BadRequestException);
    expect(() =>
      expenseRange({ from: '2026-03-02', to: '2026-03-01' }),
    ).toThrow(BadRequestException);
  });
  it('reserves the normalized stock purchases category', () => {
    expect(() => expenseCategoryName(' STOCK PURCHASES ')).toThrow(
      BadRequestException,
    );
    expect(() => expenseCategoryName(' ')).toThrow(BadRequestException);
    expect(expenseCategoryName(' Utilities ')).toBe('Utilities');
  });
  it('validates full corrections, text bounds, page sizes and nullable category updates at transport boundary', async () => {
    expect(
      await validate(
        plainToInstance(UpdateExpenseDto, {
          ...input,
          revision: 1,
          reason: 'Correction',
        }),
      ),
    ).toEqual([]);
    expect(
      (
        await validate(
          plainToInstance(UpdateExpenseDto, {
            ...input,
            revision: 0,
            reason: ' ',
          }),
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await validate(
          plainToInstance(CreateExpenseDto, {
            ...input,
            notes: 'x'.repeat(1001),
          }),
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (await validate(plainToInstance(ExpenseQueryDto, { page_size: '50001' })))
        .length,
    ).toBeGreaterThan(0);
    expect(
      await validate(plainToInstance(ExpenseQueryDto, { page_size: '30' })),
    ).toEqual([]);
    expect(
      (
        await validate(
          plainToInstance(UpdateExpenseCategoryDto, { is_active: null }),
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await validate(
          plainToInstance(UpdateExpenseCategoryDto, { name: null }),
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
