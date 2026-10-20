import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsISO8601,
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
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:?\d{2})$/i, {
    message: 'Estimated arrival must include a time zone (Z or UTC offset).',
  })
  receive_by?: string;
  @IsString()
  @MaxLength(120)
  @Matches(/\S/)
  delivered_by_name!: string;
}

export class SendDispatchDraftDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:?\d{2})$/i, {
    message: 'Estimated arrival must include a time zone (Z or UTC offset).',
  })
  receive_by?: string;
  @IsString()
  @MaxLength(120)
  @Matches(/\S/)
  delivered_by_name!: string;
}
