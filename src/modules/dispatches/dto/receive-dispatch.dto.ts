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

export class ReceiveDispatchItemDto {
  @IsUUID()
  dispatch_item_id!: string;

  @IsString()
  @MaxLength(80)
  @Matches(/^\d+(?:\.\d+)?$/)
  quantity_received!: string;
}

export class ReceiveDispatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReceiveDispatchItemDto)
  items!: ReceiveDispatchItemDto[];
}
