import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsInt,
  Min,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export class CreateSaleItemDto {
  @IsInt()
  @Min(1)
  price_revision!: number;
  @IsUUID()
  product_id!: string;

  @IsString()
  @MaxLength(60)
  @Matches(DECIMAL_PATTERN)
  quantity!: string;
}

export class CreateSaleDto {
  @IsOptional()
  @IsUUID()
  payment_method_id?: string;

  @IsIn(['DINE_IN', 'TAKEAWAY'])
  service_type!: 'DINE_IN' | 'TAKEAWAY';
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  tender_method!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => CreateSaleItemDto)
  items!: CreateSaleItemDto[];
}
