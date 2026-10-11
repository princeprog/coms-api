import { Transform } from 'class-transformer';
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
} from 'class-validator';
const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
export class CreateProductDto {
  @Transform(trimText)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  product_name!: string;
  @Transform(trimText)
  @IsString()
  @MaxLength(80)
  @Matches(/^\d+(?:\.\d+)?$/, {
    message: 'Enter a nonnegative selling price as decimal text',
  })
  price!: string;
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(1000)
  description?: string | null;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @ArrayUnique()
  @IsIn(['DINE_IN', 'TAKEAWAY'], { each: true })
  service_types: ('DINE_IN' | 'TAKEAWAY')[] = ['DINE_IN', 'TAKEAWAY'];
  @IsArray()
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  branch_ids: string[] = [];
}
