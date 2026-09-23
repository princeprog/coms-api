import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateStockItemDto {
  @Transform(trimText)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  stock_item_name!: string;

  @Transform(trimText)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  category!: string;

  @Transform(trimText)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  unit!: string;
}
