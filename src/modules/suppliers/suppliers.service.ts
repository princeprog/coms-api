import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { SupplierQueryDto } from './dto/supplier-query.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { SuppliersRepository } from './suppliers.repository';

function nullableText(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

@Injectable()
export class SuppliersService {
  constructor(private readonly repository: SuppliersRepository) {}

  list(query: SupplierQueryDto) {
    const search = query.search?.trim();
    return this.repository.list({
      page: query.page,
      page_size: query.page_size,
      ...(search ? { search } : {}),
      ...(query.is_active === undefined ? {} : { is_active: query.is_active }),
    });
  }

  async get(id: string) {
    const supplier = await this.repository.findById(id);
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  create(input: CreateSupplierDto) {
    const supplierName = input.supplier_name.trim();
    if (supplierName.length < 2)
      throw new BadRequestException(
        'Supplier name must contain at least 2 characters',
      );

    const email = nullableText(input.email)?.toLowerCase() ?? null;
    return this.repository.create({
      supplier_name: supplierName,
      contact_person: nullableText(input.contact_person),
      contact_number: nullableText(input.contact_number),
      email,
      address: nullableText(input.address),
    });
  }

  async update(id: string, input: UpdateSupplierDto) {
    const patch: Parameters<SuppliersRepository['update']>[1] = {
      ...(input.supplier_name !== undefined
        ? { supplier_name: input.supplier_name.trim() }
        : {}),
      ...(input.contact_person !== undefined
        ? { contact_person: nullableText(input.contact_person) }
        : {}),
      ...(input.contact_number !== undefined
        ? { contact_number: nullableText(input.contact_number) }
        : {}),
      ...(input.email !== undefined
        ? { email: nullableText(input.email)?.toLowerCase() ?? null }
        : {}),
      ...(input.address !== undefined
        ? { address: nullableText(input.address) }
        : {}),
    };

    if (Object.keys(patch).length === 0)
      throw new BadRequestException('At least one supplier field is required');
    if (patch.supplier_name !== undefined && patch.supplier_name.length < 2)
      throw new BadRequestException(
        'Supplier name must contain at least 2 characters',
      );

    return this.repository.update(id, patch);
  }

  deactivate(id: string) {
    return this.repository.deactivate(id);
  }
}
