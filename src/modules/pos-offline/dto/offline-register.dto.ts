import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class DeviceDto {
  @IsUUID() device_id!: string;
}

export class OfflinePageDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page = 1;
  @Type(() => Number) @IsInt() @IsIn([10, 25, 30, 50, 100]) page_size = 10;
}
export class RegisterDeviceDto extends DeviceDto {
  @IsString() @MinLength(1) @MaxLength(80) @Matches(/\S/) name!: string;
}
export class UpdateDeviceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/\S/)
  name?: string;
  @IsOptional() @IsIn(['APPROVED', 'REVOKED']) status?: 'APPROVED' | 'REVOKED';
}
export class OfflineItemDto {
  @IsUUID() product_id!: string;
  @IsString() @Matches(/^\d{1,12}(\.\d{1,6})?$/) quantity!: string;
  @IsString() @Matches(/^\d{1,12}(\.\d{1,6})?$/) unit_price!: string;
  @IsInt() @Min(1) @Max(2147483647) price_revision!: number;
}
export class OfflineEnvelopeDto {
  @IsUUID() id!: string;
  @IsUUID() session_id!: string;
  @IsUUID() device_id!: string;
  @IsUUID() shift_id!: string;
  @IsInt() @Min(1) @Max(1000000000) sequence!: number;
  @IsUUID() snapshot_id!: string;
  @IsString()
  @MaxLength(40)
  @Matches(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/,
  )
  captured_at!: string;
  @IsIn(['DINE_IN', 'TAKEAWAY']) service_type!: 'DINE_IN' | 'TAKEAWAY';
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => OfflineItemDto)
  items!: OfflineItemDto[];
  @IsString() @Matches(/^\d{1,15}(\.\d{1,6})?$/) cash_tendered!: string;
  @IsString() @Matches(/^\d{1,15}(\.\d{1,6})?$/) total_amount!: string;
}
export class SyncOfflineDto extends DeviceDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => OfflineEnvelopeDto)
  transactions!: OfflineEnvelopeDto[];
}
export class RecoverOfflineDto extends SyncOfflineDto {
  @IsString() @MinLength(3) @MaxLength(500) @Matches(/\S/) reason!: string;
}
export class FinalizeOfflineDto extends DeviceDto {
  @IsInt() @Min(0) @Max(1000000000) final_sequence!: number;
}
export class ReviewOfflineDto {
  @IsUUID() transaction_id!: string;
  @IsString() @MinLength(3) @MaxLength(500) @Matches(/\S/) reason!: string;
}

export class RecoverFinalizeDto extends FinalizeOfflineDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @IsUUID('all', { each: true })
  transaction_ids!: string[];
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  @Matches(/\S/)
  reason!: string;
}
