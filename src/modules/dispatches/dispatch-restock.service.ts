import { Injectable, NotFoundException } from '@nestjs/common';
import type { AccessContext } from '../access-control/access-control.types';
import { DispatchRestockRepository } from './dispatch-restock.repository';

@Injectable()
export class DispatchRestockService {
  constructor(private readonly repository: DispatchRestockRepository) {}

  async suggestions(branchId: string, access: AccessContext) {
    if (!(await this.repository.isActiveBranch(branchId)))
      throw new NotFoundException('Active branch not found');
    const superAdmin = Boolean(
      access.role?.isSystem &&
      access.role.isActive &&
      access.role.code === 'SUPER_ADMIN',
    );
    // Commissary balances stay with people who may read commissary stock.
    const showAvailable =
      superAdmin || access.permissions.includes('inventory.commissary_read');
    const rows = await this.repository.suggestions(branchId);
    return {
      branch_id: branchId,
      items: rows.map((row) => ({
        ...row,
        commissary_available: showAvailable ? row.commissary_available : null,
      })),
    };
  }
}
