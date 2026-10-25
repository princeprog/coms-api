import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
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
  ValidateNested,
} from 'class-validator';

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):(?:00|30)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const time = { message: 'Use a time on the hour or half hour, like 06:00' };

export class ShiftTemplateDto {
  @IsString()
  @MaxLength(40)
  name!: string;

  @Matches(TIME_PATTERN, time)
  start_time!: string;

  @Matches(TIME_PATTERN, time)
  end_time!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Choose at least one day' })
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  weekdays!: number[];
}

export class UpdateShiftTemplateDto extends ShiftTemplateDto {
  @IsInt()
  @Min(1)
  revision!: number;
}

export class ScheduleWeekQueryDto {
  @IsOptional()
  @Matches(DATE_PATTERN)
  week?: string;
}

export class PatternAssignmentDto {
  @IsUUID()
  template_id!: string;

  @IsInt()
  @Min(1)
  @Max(7)
  weekday!: number;
}

export class StaffPatternDto {
  @IsArray()
  @ArrayMaxSize(84)
  @ValidateNested({ each: true })
  @Type(() => PatternAssignmentDto)
  assignments!: PatternAssignmentDto[];
}

export class ScheduleExceptionDto {
  @IsUUID()
  user_id!: string;

  @IsUUID()
  template_id!: string;

  @Matches(DATE_PATTERN)
  work_date!: string;

  @IsIn(['OFF', 'EXTRA'])
  kind!: 'OFF' | 'EXTRA';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
