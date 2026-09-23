import { Transform } from 'class-transformer';
import {
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateInventoryAdjustmentDto {
  @IsUUID()
  stock_item_id!: string;

  @IsString()
  @MaxLength(80)
  @Matches(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/)
  quantity_delta!: string;

  @Transform(trimText)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
