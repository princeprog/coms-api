import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AccessContext } from '../access-control/access-control.types';
import { decimal } from '../../common/utils/menu-rules';
import { resolveCostRange } from './cost-range';
import { CostsRepository, type BranchScope } from './costs.repository';
import type {
  CostRangeQueryDto,
  ProductCostQueryDto,
  SetStockCostDto,
  StockCostQueryDto,
} from './dto/cost-query.dto';

function isSuperAdmin(access: AccessContext) {
  return Boolean(
    access.role?.isSystem &&
    access.role.isActive &&
    access.role.code === 'SUPER_ADMIN',
  );
}

@Injectable()
export class CostsService {
  constructor(private readonly repository: CostsRepository) {}

  productCosts(query: ProductCostQueryDto) {
    return this.repository.productCosts(query);
  }

  stockCosts(query: StockCostQueryDto) {
    return this.repository.stockCosts(query);
  }

  branchProfit(query: CostRangeQueryDto, access: AccessContext) {
    return this.repository.branchProfit(
      resolveCostRange(query),
      this.scope(access, query.branch_id),
    );
  }

  branchProductProfit(query: CostRangeQueryDto, access: AccessContext) {
    return this.repository.branchProductProfit(
      resolveCostRange(query),
      this.scope(access, query.branch_id),
      query,
    );
  }

  setStockCost(id: string, input: SetStockCostDto, access: AccessContext) {
    return this.repository.setStockCost(
      id,
      decimal(input.unit_cost),
      access.userId,
    );
  }

  // Global readers see every branch; others only their assigned branches.
  scope(access: AccessContext, branchId?: string): BranchScope {
    if (
      isSuperAdmin(access) ||
      access.permissions.includes('costs.global_read')
    )
      return branchId ? [branchId] : null;
    if (branchId) {
      if (!access.branchIds.includes(branchId))
        throw new ForbiddenException('Branch access required');
      return [branchId];
    }
    if (!access.branchIds.length)
      throw new ForbiddenException('Branch access required');
    return access.branchIds;
  }
}
