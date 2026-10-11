import { Injectable } from '@nestjs/common';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductQueryDto } from './dto/product-query.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsRepository } from './products.repository';
import { ProductSetupRepository } from './product-setup.repository';
import type { AccessContext } from '../access-control/access-control.types';
import { requireSuperAdmin } from '../../common/utils/menu-rules';
@Injectable()
export class ProductsService {
  constructor(
    private readonly repository: ProductsRepository,
    private readonly setup: ProductSetupRepository,
  ) {}
  list(query: ProductQueryDto) {
    return this.repository.list({
      page: query.page,
      page_size: query.page_size,
      is_active: query.is_active,
      search: query.search?.trim(),
    });
  }
  get(id: string) {
    return this.repository.findById(id);
  }
  async create(input: CreateProductDto, access: AccessContext) {
    requireSuperAdmin(access);
    return (await this.setup.save(undefined, input, 0, access)).product;
  }
  async update(id: string, input: UpdateProductDto, access: AccessContext) {
    requireSuperAdmin(access);
    return (
      await this.setup.save(id, input, input.expected_product_revision, access)
    ).product;
  }
  deactivate(id: string) {
    return this.repository.deactivate(id);
  }
}
