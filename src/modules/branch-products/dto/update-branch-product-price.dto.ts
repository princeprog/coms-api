import { IsString, Matches, MaxLength } from 'class-validator';

export class UpdateBranchProductPriceDto {
  @IsString()
  @MaxLength(80)
  @Matches(/^\d+(?:\.\d+)?$/, {
    message: 'price must be a nonnegative decimal string',
  })
  price!: string;
}
