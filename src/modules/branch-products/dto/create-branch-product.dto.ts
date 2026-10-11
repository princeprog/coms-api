import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsUUID,
} from 'class-validator';

export class CreateBranchProductDto {
  @IsUUID()
  product_id!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @ArrayUnique()
  @IsIn(['DINE_IN', 'TAKEAWAY'], { each: true })
  service_types!: ('DINE_IN' | 'TAKEAWAY')[];
}
