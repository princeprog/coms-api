import { Transform, Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ArrayUnique,
  IsIn,
  IsUUID,
  Matches,
  IsInt,
  Min,
  ValidateIf,
} from 'class-validator';
const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
export class UpdateProductDto {
  @ValidateIf((_o, v) => v !== undefined)
  @Transform(trimText)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  product_name?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @Transform(trimText)
  @IsString()
  @MaxLength(80)
  @Matches(/^\d+(?:\.\d+)?$/)
  price?: string;
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(1000)
  description?: string | null;
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @ArrayUnique()
  @IsIn(['DINE_IN', 'TAKEAWAY'], { each: true })
  service_types?: ('DINE_IN' | 'TAKEAWAY')[];
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  branch_ids?: string[];
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expected_product_revision!: number;
}
