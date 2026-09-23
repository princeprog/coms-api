import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { BranchesService } from './branches.service';

vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));

describe('BranchesService', () => {
  it('limits branch listings to assignments for ordinary users', async () => {
    const repository = {
      list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    };
    const service = new BranchesService(repository as never);
    const access = {
      branchIds: ['branch-1'],
      role: { code: 'MANAGER', isSystem: false },
    } as never;

    await service.list(access, { page: 2, page_size: 15 });
    expect(repository.list).toHaveBeenCalledWith(2, 15, ['branch-1']);
  });

  it('allows only protected Super Admin to list branches globally', async () => {
    const repository = {
      list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    };
    const service = new BranchesService(repository as never);
    await service.list(
      {
        branchIds: [],
        role: { code: 'SUPER_ADMIN', isSystem: true },
      } as never,
      { page: 1, page_size: 25 },
    );
    expect(repository.list).toHaveBeenCalledWith(1, 25, undefined);
  });

  it('rejects empty updates before persistence', async () => {
    const repository = { update: vi.fn() };
    const service = new BranchesService(repository as never);
    await expect(service.update('branch-1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repository.update).not.toHaveBeenCalled();
  });
});
