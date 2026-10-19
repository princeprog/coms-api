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

export class CreateDispatchItemDto {
  @IsUUID()
  stock_item_id!: string;

  @IsString()
  @MaxLength(80)
  @Matches(/^\d+(?:\.\d+)?$/)
  quantity_dispatched!: string;
}

export class CreateDispatchDto {
  @IsUUID()
  branch_id!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateDispatchItemDto)
  items!: CreateDispatchItemDto[];
}

export class SendDispatchDto extends CreateDispatchDto {
  @IsString()
  @MaxLength(120)
  @Matches(/\S/)
  delivered_by_name!: string;
}

export class SendDispatchDraftDto {
  @IsString()
  @MaxLength(120)
  @Matches(/\S/)
  delivered_by_name!: string;
}
