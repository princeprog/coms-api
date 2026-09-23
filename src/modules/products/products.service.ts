import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductQueryDto } from './dto/product-query.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsRepository } from './products.repository';

function nullableText(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

@Injectable()
export class ProductsService {
  constructor(private readonly repository: ProductsRepository) {}

  list(query: ProductQueryDto) {
    const search = query.search?.trim();
    return this.repository.list({
      page: query.page,
      page_size: query.page_size,
      ...(search ? { search } : {}),
      ...(query.is_active === undefined ? {} : { is_active: query.is_active }),
    });
  }

  async get(id: string) {
    const product = await this.repository.findById(id);
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  create(input: CreateProductDto) {
    const productName = input.product_name.trim();
    if (productName.length < 2)
      throw new BadRequestException(
        'Product name must contain at least 2 characters',
      );
    return this.repository.create({
      product_name: productName,
      description: nullableText(input.description),
    });
  }

  async update(id: string, input: UpdateProductDto) {
    const patch: Parameters<ProductsRepository['update']>[1] = {
      ...(input.product_name !== undefined
        ? { product_name: input.product_name.trim() }
        : {}),
      ...(input.description !== undefined
        ? { description: nullableText(input.description) }
        : {}),
    };

    if (Object.keys(patch).length === 0)
      throw new BadRequestException('At least one product field is required');
    if (patch.product_name !== undefined && patch.product_name.length < 2)
      throw new BadRequestException(
        'Product name must contain at least 2 characters',
      );

    return this.repository.update(id, patch);
  }

  deactivate(id: string) {
    return this.repository.deactivate(id);
  }
}
