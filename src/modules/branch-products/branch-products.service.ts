import { Injectable } from '@nestjs/common';
import { CreateBranchProductDto } from './dto/create-branch-product.dto';
import { BranchProductQueryDto } from './dto/branch-product-query.dto';
import { UpdateBranchProductAvailabilityDto } from './dto/update-branch-product-availability.dto';
import { UpdateBranchProductPriceDto } from './dto/update-branch-product-price.dto';
import { BranchProductsRepository } from './branch-products.repository';

@Injectable()
export class BranchProductsService {
  constructor(private readonly repository: BranchProductsRepository) {}

  list(branchId: string, query: BranchProductQueryDto) {
    const search = query.search?.trim();
    return this.repository.list(branchId, {
      page: query.page,
      page_size: query.page_size,
      ...(search ? { search } : {}),
      ...(query.is_available === undefined
        ? {}
        : { is_available: query.is_available }),
    });
  }

  get(branchId: string, productId: string) {
    return this.repository.findByIds(branchId, productId);
  }

  create(branchId: string, input: CreateBranchProductDto) {
    return this.repository.create(branchId, input.product_id, input.price);
  }

  updatePrice(
    branchId: string,
    productId: string,
    input: UpdateBranchProductPriceDto,
  ) {
    return this.repository.updatePrice(branchId, productId, input.price);
  }

  updateAvailability(
    branchId: string,
    productId: string,
    input: UpdateBranchProductAvailabilityDto,
  ) {
    return this.repository.updateAvailability(
      branchId,
      productId,
      input.is_available,
    );
  }
}
