import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { DISPATCH_RESOLUTION_OUTCOMES } from '../dispatches.types';
import type { DispatchResolutionOutcome } from '../dispatches.types';

export class CloseDispatchShortageItemDto {
  @IsUUID()
  dispatch_item_id!: string;

  @IsString()
  @MaxLength(80)
  @Matches(/^\d+(?:\.\d+)?$/)
  quantity_closed!: string;
}

export class CloseDispatchShortageDto {
  @IsIn(DISPATCH_RESOLUTION_OUTCOMES)
  outcome!: DispatchResolutionOutcome;

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
