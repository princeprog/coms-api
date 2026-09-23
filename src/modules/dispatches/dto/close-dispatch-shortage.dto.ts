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

export class CloseDispatchShortageItemDto {
  @IsUUID()
  dispatch_item_id!: string;

  @IsString()
  @MaxLength(80)
  @Matches(/^\d+(?:\.\d+)?$/)
  quantity_closed!: string;
}

export class CloseDispatchShortageDto {
  @IsString()
  @MaxLength(500)
  @Matches(/\S/)
  reason!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CloseDispatchShortageItemDto)
  items!: CloseDispatchShortageItemDto[];
}
