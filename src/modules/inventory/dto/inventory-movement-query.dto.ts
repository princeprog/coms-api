import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { IsOptional, IsUUID } from 'class-validator';

export class InventoryMovementQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  stock_item_id?: string;
}
