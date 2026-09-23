import { ArrayMaxSize, ArrayUnique, IsArray, Matches } from 'class-validator';

export class AssignStaffBranchesDto {
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @Matches(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    {
      each: true,
    },
  )
  branch_ids!: string[];
}
