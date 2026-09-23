import { IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CreateBranchProductDto {
  @IsUUID()
  product_id!: string;

  @IsString()
  @MaxLength(80)
  @Matches(/^\d+(?:\.\d+)?$/, {
    message: 'price must be a nonnegative decimal string',
  })
  price!: string;
}
