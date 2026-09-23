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

export class CreateSupplierReceiptItemDto {
  @IsUUID()
  stock_item_id!: string;

  @IsString()
  @MaxLength(80)
  @Matches(/^\d+(?:\.\d+)?$/)
  quantity_received!: string;

  @IsString()
  @MaxLength(80)
  @Matches(/^\d+(?:\.\d+)?$/)
  unit_cost!: string;
}

export class CreateSupplierReceiptDto {
  @IsUUID()
  supplier_id!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  received_at!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateSupplierReceiptItemDto)
  items!: CreateSupplierReceiptItemDto[];
}
