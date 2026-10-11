import { Injectable } from '@nestjs/common';
import type { AccessContext } from '../access-control/access-control.types';
import { retryKey, requireSuperAdmin } from '../../common/utils/menu-rules';
import type { ProductSetupDto } from './dto/product-setup.dto';
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
    );
  }
}
