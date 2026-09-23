import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class CreateStockRequestItemDto {
  @IsUUID()
  stock_item_id!: string;

  @IsString()
  @MaxLength(80)
  @Matches(/^\d+(?:\.\d+)?$/)
  quantity_requested!: string;
}

export class CreateStockRequestDto {
  @IsUUID()
  branch_id!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateStockRequestItemDto)
  items!: CreateStockRequestItemDto[];
}
