import { IsBoolean } from 'class-validator';

export class UpdateBranchProductAvailabilityDto {
  @IsBoolean()
  is_available!: boolean;
}
