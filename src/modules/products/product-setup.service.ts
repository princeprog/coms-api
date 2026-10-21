import { BadRequestException, Injectable } from '@nestjs/common';
import type { AccessContext } from '../access-control/access-control.types';
import {
  decimal,
  retryKey,
  requireSuperAdmin,
} from '../../common/utils/menu-rules';
import type { ProductSetupDto, RecipeLineDto } from './dto/product-setup.dto';
import { ProductSetupRepository } from './product-setup.repository';
@Injectable()
export class ProductSetupService {
  constructor(private readonly repository: ProductSetupRepository) {}
  get(id: string, access: AccessContext) {
    return this.repository.get(id, access);
  }
  save(
    id: string | undefined,
    input: ProductSetupDto,
    access: AccessContext,
    key?: string,
  ) {
    requireSuperAdmin(access);
    return this.repository.save(
      id,
      input.product,
      input.expected_product_revision,
      access,
      retryKey(key),
      input.recipe === undefined
        ? undefined
        : this.normalizeRecipe(input.recipe),
    );
  }

  // A stock item is either used by every sale or by specific services, never
  // both, so one sale never counts the same item from two lines.
  private normalizeRecipe(lines: RecipeLineDto[]) {
    const scopesByStockItem = new Map<string, Set<string>>();
    const normalized = lines.map((line) => {
      const quantity = decimal(line.quantity);
      if (/^0(?:\.0+)?$/.test(quantity))
        throw new BadRequestException(
          'Recipe quantities must be greater than zero',
        );
      const scopes = scopesByStockItem.get(line.stock_item_id) ?? new Set();
      if (
        scopes.has(line.usage_scope) ||
        (line.usage_scope === 'ALL' && scopes.size > 0) ||
        scopes.has('ALL')
      )
        throw new BadRequestException(
          'Each stock item can appear once for every sale, or once per service',
        );
      scopes.add(line.usage_scope);
      scopesByStockItem.set(line.stock_item_id, scopes);
      return { ...line, quantity };
    });
    return normalized.sort(
      (a, b) =>
        a.stock_item_id.localeCompare(b.stock_item_id) ||
        a.usage_scope.localeCompare(b.usage_scope),
    );
  }
}
