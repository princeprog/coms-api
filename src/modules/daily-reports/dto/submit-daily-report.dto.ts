import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
export class DeliveryExceptionDto {
  @IsUUID() dispatch_id!: string;
  @IsString() @Matches(/\S/) @MaxLength(500) reason!: string;
}
export class SubmitDailyReportDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => DeliveryExceptionDto)
  delivery_exceptions?: DeliveryExceptionDto[];
}
