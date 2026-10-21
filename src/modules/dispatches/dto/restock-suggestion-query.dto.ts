import { IsUUID } from 'class-validator';

export class RestockSuggestionQueryDto {
  @IsUUID()
  branch_id!: string;
}
