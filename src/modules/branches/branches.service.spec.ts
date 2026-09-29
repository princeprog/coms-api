import { BadRequestException, ConflictException } from '@nestjs/common';
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

  it('assigns a stable-format code when creating a branch', async () => {
    const repository = {
      create: vi.fn().mockResolvedValue({ id: 'branch-1' }),
    };
    const service = new BranchesService(repository as never);

    await service.create({ branch_name: ' Manila South ' });

    expect(repository.create).toHaveBeenCalledWith({
      branch_name: 'Manila South',
      code: expect.stringMatching(/^BR-[A-F0-9]{16}$/),
    });
  });

  it('retries a generated code if it collides with an existing branch', async () => {
    const repository = {
      create: vi
        .fn()
        .mockRejectedValueOnce(
          new ConflictException('Branch code already exists'),
        )
        .mockResolvedValueOnce({ id: 'branch-2' }),
    };
    const service = new BranchesService(repository as never);

    await expect(
      service.create({ branch_name: 'Manila South' }),
    ).resolves.toEqual({
      id: 'branch-2',
    });
    expect(repository.create).toHaveBeenCalledTimes(2);
    expect(repository.create.mock.calls[0][0].code).not.toBe(
      repository.create.mock.calls[1][0].code,
    );
  });
});
