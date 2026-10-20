import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Peso amounts as decimal strings with at most two decimal places. */
export const MONEY_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const money = { message: 'Enter an amount in pesos with up to two decimals' };

export class OpenShiftDto {
  @IsString()
  @Matches(MONEY_PATTERN, money)
  opening_float!: string;
}

export class CashMovementDto {
  @IsIn(['IN', 'OUT'])
  direction!: 'IN' | 'OUT';

  @IsString()
  @Matches(MONEY_PATTERN, money)
  amount!: string;

  @IsString()
  @MaxLength(300)
  reason!: string;
}

export class CloseShiftDto {
  @IsString()
  @Matches(MONEY_PATTERN, money)
  counted_cash!: string;

  @IsString()
  @Matches(MONEY_PATTERN, money)
  left_in_drawer!: string;
}

export class ForceCloseShiftDto extends CloseShiftDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class ShiftExplanationDto {
  @IsString()
  @MaxLength(500)
  explanation!: string;
}

export class ReviewShiftDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ShiftQueryDto {
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

  @IsOptional()
  @IsIn(['OPEN', 'CLOSED', 'REVIEWED'])
  status?: 'OPEN' | 'CLOSED' | 'REVIEWED';

  @IsOptional()
  @Matches(DATE_PATTERN)
  date_from?: string;

  @IsOptional()
  @Matches(DATE_PATTERN)
  date_to?: string;
}
