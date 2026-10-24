import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import type { ExpenseInput, ExpenseSource } from '../expense.types';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ExpensePaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page = 1;
  @IsOptional()
  @Type(() => Number)
  @IsIn([10, 30, 50])
  page_size = 10;
}

export class ExpenseQueryDto extends ExpensePaginationDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;
  @IsOptional()
  @IsIn(['COMMISSARY', 'BRANCH'])
  scope?: 'COMMISSARY' | 'BRANCH';
  @IsOptional()
  @IsUUID()
  branch_id?: string;
  @IsOptional()
  @IsString()
  @MaxLength(40)
  category_id?: string;
  @IsOptional()
  @IsIn(['OPERATING', 'SUPPLIER_DELIVERY', 'DIRECT_PURCHASE'])
  source?: ExpenseSource;
  @IsOptional()
  @IsIn(['RECORDED', 'VOIDED', 'all'])
  status?: 'RECORDED' | 'VOIDED' | 'all';
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  search?: string;
  @IsOptional()
  @IsIn(['newest', 'oldest', 'amount_highest', 'amount_lowest'])
  sort?: 'newest' | 'oldest' | 'amount_highest' | 'amount_lowest';
}

export class CreateExpenseDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expense_date!: string;
  @IsIn(['COMMISSARY', 'BRANCH'])
  scope!: ExpenseInput['scope'];
  @IsOptional()
  @IsUUID()
  branch_id?: string | null;
  @IsUUID()
  category_id!: string;
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  description!: string;
  @Transform(trim)
  @IsString()
  @Matches(/^\d{1,9}(?:\.\d{1,2})?$/)
  amount!: string;
  @IsIn(['CASH', 'BANK_TRANSFER', 'EWALLET', 'CARD', 'OTHER'])
  payment_method!: ExpenseInput['payment_method'];
  @IsOptional()
  @IsIn(['REGISTER', 'OTHER'])
  cash_source?: ExpenseInput['cash_source'];
  @IsOptional()
  @IsUUID()
  cash_movement_id?: string | null;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  payee?: string | null;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  reference?: string | null;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class UpdateExpenseDto extends CreateExpenseDto {
  @IsInt()
  @Min(1)
  @Max(2_147_483_646)
  revision!: number;
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class VoidExpenseDto {
  @IsInt()
  @Min(1)
  @Max(2_147_483_646)
  revision!: number;
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class CashOutQueryDto extends ExpensePaginationDto {
  @IsUUID()
  branch_id!: string;
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  search?: string;
}

export class CreateExpenseCategoryDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;
}

export class UpdateExpenseCategoryDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  is_active?: boolean;
}
