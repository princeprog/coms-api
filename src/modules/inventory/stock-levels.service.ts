import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AccessContext } from '../access-control/access-control.types';
import { SetStockLevelsDto } from './dto/set-stock-levels.dto';
import { parseLevels } from './stock-levels.policy';
import { StockLevelsRepository } from './stock-levels.repository';

function isSuperAdmin(access: AccessContext) {
  return Boolean(
    access.role?.isSystem &&
    access.role.isActive &&
    access.role.code === 'SUPER_ADMIN',
  );
}

@Injectable()
export class StockLevelsService {
  constructor(private readonly repository: StockLevelsRepository) {}

  set(input: SetStockLevelsDto, access: AccessContext) {
    const levels = parseLevels(input.reorder_level, input.target_level);
    if (input.scope === 'COMMISSARY') {
      if (input.branch_ids?.length)
        throw new BadRequestException('Commissary levels do not take branches');
      return this.repository.set({
        stockItemId: input.stock_item_id,
        branchIds: null,
        levels,
        actorUserId: access.userId,
      });
    }

    const branchIds = (input.branch_ids ?? []).map((id) => id.toLowerCase());
    if (!branchIds.length)
      throw new BadRequestException('Choose at least one branch');
    if (
      !isSuperAdmin(access) &&
      branchIds.some((id) => !access.branchIds.includes(id))
    )
      throw new ForbiddenException(
        'You can only set levels for your assigned branches',
      );
    return this.repository.set({
      stockItemId: input.stock_item_id,
      branchIds,
      levels,
      actorUserId: access.userId,
    });
  }
}
