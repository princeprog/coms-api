import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const NONNEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export class UpdateDailyReportItemDto {
  @IsUUID()
  stock_item_id!: string;

  @IsString()
  @MaxLength(80)
  @Matches(NONNEGATIVE_DECIMAL)
  physical_closing_quantity!: string;

  @IsString()
  @MaxLength(80)
  @Matches(NONNEGATIVE_DECIMAL)
  waste_quantity!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  waste_reason?: string;

  @IsString()
  @MaxLength(80)
  @Matches(SIGNED_DECIMAL)
  adjustment_quantity!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  adjustment_reason?: string;
}

export class UpdateDailyReportDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => UpdateDailyReportItemDto)
  items!: UpdateDailyReportItemDto[];
}
