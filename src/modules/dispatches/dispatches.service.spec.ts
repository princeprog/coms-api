import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AccessContext } from '../access-control/access-control.types';
import { DispatchesService } from './dispatches.service';

vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));

function accessContext(branchIds: string[]): AccessContext {
  return {
    userId: randomUUID(),
    accountActive: true,
    role: {
      id: 'role-1',
      code: 'COMMISSARY_MANAGER',
      name: 'Commissary Manager',
      isSystem: false,
      isActive: true,
    },
    permissions: ['dispatches.create'],
    branchIds,
  };
}

describe('DispatchesService direct creation', () => {
  it.each(['dispatches.create', 'dispatches.dispatch'] as const)(
    'requires %s when sending',
    async (missing) => {
      const branchId = randomUUID();
      const access = accessContext([branchId]);
      access.permissions = ['dispatches.create', 'dispatches.dispatch'].filter(
        (p) => p !== missing,
      ) as AccessContext['permissions'];
      const service = new DispatchesService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      await expect(
        service.send(
          {
            branch_id: branchId,
            items: [{ stock_item_id: randomUUID(), quantity_dispatched: '1' }],
          },
          access,
          randomUUID(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
  it('creates a draft from the selected branch and normalized stock lines', async () => {
    const branchId = randomUUID();
    const stockItemId = randomUUID();
    const access = accessContext([branchId]);
    const repository = {
      findActiveBranch: vi.fn().mockResolvedValue({ id: branchId }),
    };
    const drafts = {
      createDraft: vi
        .fn()
        .mockResolvedValue({ id: 'dispatch-1', status: 'DRAFT' }),
    };
    const service = new DispatchesService(
      repository as never,
      drafts as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.create(
        {
          branch_id: branchId,
          items: [
            { stock_item_id: stockItemId, quantity_dispatched: '002.5000' },
          ],
        } as never,
        access,
        randomUUID(),
      ),
    ).resolves.toMatchObject({ status: 'DRAFT' });
    expect(drafts.createDraft).toHaveBeenCalledWith({
      branch_id: branchId,
      items: [{ stock_item_id: stockItemId, quantity_dispatched: '2.5' }],
      created_by_user_id: access.userId,
      idempotency_key: expect.any(String),
    });
  });

  it('rejects branches outside the current assignments', async () => {
    const requestedBranchId = randomUUID();
    const repository = {
      findActiveBranch: vi.fn().mockResolvedValue({ id: requestedBranchId }),
    };
    const drafts = { createDraft: vi.fn() };
    const service = new DispatchesService(
      repository as never,
      drafts as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.create(
        {
          branch_id: requestedBranchId,
          items: [{ stock_item_id: randomUUID(), quantity_dispatched: '1' }],
        } as never,
        accessContext([randomUUID()]),
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(drafts.createDraft).not.toHaveBeenCalled();
  });

  it('rejects duplicate stock items and zero quantities', async () => {
    const branchId = randomUUID();
    const stockItemId = randomUUID();
    const repository = {
      findActiveBranch: vi.fn().mockResolvedValue({ id: branchId }),
    };
    const drafts = { createDraft: vi.fn() };
    const service = new DispatchesService(
      repository as never,
      drafts as never,
      {} as never,
      {} as never,
    );
    const access = accessContext([branchId]);

    await expect(
      service.create(
        {
          branch_id: branchId,
          items: [
            { stock_item_id: stockItemId, quantity_dispatched: '1' },
            { stock_item_id: stockItemId, quantity_dispatched: '2' },
          ],
        } as never,
        access,
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(
        {
          branch_id: branchId,
          items: [{ stock_item_id: randomUUID(), quantity_dispatched: '0' }],
        } as never,
        access,
        randomUUID(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(drafts.createDraft).not.toHaveBeenCalled();
  });
});
