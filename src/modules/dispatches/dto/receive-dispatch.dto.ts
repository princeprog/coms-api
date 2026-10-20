import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class ReceiveDispatchItemDto {
  @IsUUID()
  dispatch_item_id!: string;

  @IsString()
  @MaxLength(80)
  @Matches(/^\d+(?:\.\d+)?$/)
  quantity_received!: string;
}

export class ReceiveDispatchDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  delivery_date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  late_reason?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReceiveDispatchItemDto)
  items!: ReceiveDispatchItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
