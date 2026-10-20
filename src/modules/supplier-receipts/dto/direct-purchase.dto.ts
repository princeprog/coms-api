import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { CreateSupplierReceiptItemDto } from './create-supplier-receipt.dto';
export class CreateDirectPurchaseDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) purchase_date!: string;
  @IsOptional() @IsString() @MaxLength(160) store_name?: string;
  @IsOptional() @IsString() @MaxLength(100) receipt_number?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateSupplierReceiptItemDto)
  items!: CreateSupplierReceiptItemDto[];
}
export class DirectPurchaseQueryDto extends PaginationQueryDto {
  @IsIn([10, 30, 50]) override page_size = 10;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) purchased_from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) purchased_to?: string;
  @IsOptional() @IsIn(['newest', 'oldest']) sort: 'newest' | 'oldest' =
    'newest';
}
