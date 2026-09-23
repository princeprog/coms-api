import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimOptionalText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

export class UpdateSupplierDto {
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trimText)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  supplier_name?: string;

  @IsOptional()
  @Transform(trimOptionalText)
  @IsString()
  @MaxLength(120)
  contact_person?: string | null;

  @IsOptional()
  @Transform(trimOptionalText)
  @IsString()
  @MaxLength(32)
  contact_number?: string | null;

  @IsOptional()
  @Transform(trimOptionalText)
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  @IsOptional()
  @Transform(trimOptionalText)
  @IsString()
  @MaxLength(1000)
  address?: string | null;
}
