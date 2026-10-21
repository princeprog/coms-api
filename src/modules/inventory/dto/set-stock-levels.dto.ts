import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';

export class SetStockLevelsDto {
  @IsUUID()
  stock_item_id!: string;

  @IsIn(['COMMISSARY', 'BRANCH'])
  scope!: 'COMMISSARY' | 'BRANCH';

  /** Branches to set when scope is BRANCH. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  branch_ids?: string[];

  /** Decimal string, or null with target_level null to clear the levels. */
  @ValidateIf((_, value) => value !== null)
  @IsString()
  reorder_level!: string | null;

  @ValidateIf((_, value) => value !== null)
  @IsString()
  target_level!: string | null;
}
