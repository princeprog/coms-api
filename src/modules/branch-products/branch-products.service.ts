import { Injectable } from '@nestjs/common';
import { CreateBranchProductDto } from './dto/create-branch-product.dto';
import { BranchProductQueryDto } from './dto/branch-product-query.dto';
import { UpdateBranchProductAvailabilityDto } from './dto/update-branch-product-availability.dto';
import { BranchProductsRepository } from './branch-products.repository';

@Injectable()
export class BranchProductsService {
  constructor(private readonly repository: BranchProductsRepository) {}

  list(branchId: string, query: BranchProductQueryDto) {
    const search = query.search?.trim();
    return this.repository.list(branchId, {
      sort_by: query.sort_by ?? 'product_name',
      sort_order: query.sort_order ?? 'asc',
      service_type: query.service_type,
      eligible_only: query.eligible_only,
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

  updateServices(branchId: string, productId: string, types: string[]) {
    return this.repository.updateServices(branchId, productId, types);
  }

  create(branchId: string, input: CreateBranchProductDto) {
    return this.repository.create(
      branchId,
      input.product_id,
      input.service_types,
    );
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
