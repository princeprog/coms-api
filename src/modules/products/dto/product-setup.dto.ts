import { Type } from 'class-transformer';
import { IsDefined, IsInt, Min, ValidateNested } from 'class-validator';
import { CreateProductDto } from './create-product.dto';
export class ProductSetupDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expected_product_revision!: number;
  @IsDefined()
  @ValidateNested()
  @Type(() => CreateProductDto)
  product!: CreateProductDto;
}
