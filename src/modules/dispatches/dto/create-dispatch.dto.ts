import { IsUUID } from 'class-validator';

export class CreateDispatchDto {
  @IsUUID()
  stock_request_id!: string;
}
