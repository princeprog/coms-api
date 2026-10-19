import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { ProductCategoriesRepository } from './product-categories.repository';
import type {
  AvailableProductCategoryQueryDto,
  CreateProductCategoryDto,
  ProductCategoryQueryDto,
  UpdateProductCategoryDto,
} from './dto/product-category.dto';
@Injectable()
export class ProductCategoriesService {
  constructor(private readonly repository: ProductCategoriesRepository) {}
  list(query: ProductCategoryQueryDto) {
    return this.repository.list(query);
  }
  available(query: AvailableProductCategoryQueryDto) {
    return this.repository.list({
      page: query.page,
      page_size: query.page_size,
      search: query.search,
      is_active: true,
    });
  }
  create(input: CreateProductCategoryDto) {
    return this.unique(() => this.repository.create(input));
  }
  update(id: string, input: UpdateProductCategoryDto) {
    if (input.name === undefined && input.is_active === undefined)
      throw new BadRequestException(
        'Provide a category name or active status.',
      );
    return this.unique(() =>
      this.repository.withLocked(id, async (tx) => {
        if (
          input.is_active === false &&
          (await this.repository.hasActiveProducts(id, tx))
        )
          throw new ConflictException(
            'Move or deactivate active products before archiving this category.',
          );
        return this.repository.update(id, input, tx);
      }),
    );
  }
  deactivate(id: string) {
    return this.update(id, { is_active: false });
  }
  private async unique<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23505'
      )
        throw new ConflictException(
          'A category with this name already exists. Edit or reactivate it instead.',
        );
      throw error;
    }
  }
}
