import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { StaffService } from './staff.service';

vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));
vi.mock('../auth/password-hashing', () => ({
  hashPassword: vi.fn().mockResolvedValue('argon-hash'),
}));

describe('StaffService', () => {
  it('normalizes account identity and hashes the password before creation', async () => {
    const repository = { create: vi.fn().mockResolvedValue({ id: 'staff-1' }) };
    const service = new StaffService(repository as never);

    await expect(
      service.create(
        {
          email: ' NEW.STAFF@EXAMPLE.COM ',
          full_name: ' New Staff ',
          contact_number: ' 09170000000 ',
          password: 'long test password',
          role_id: '4',
          branch_ids: [],
        },
        ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
        false,
      ),
    ).resolves.toEqual({ id: 'staff-1' });
    expect(repository.create).toHaveBeenCalledWith({
      email: 'new.staff@example.com',
      full_name: 'New Staff',
      contact_number: '09170000000',
      hashed_password: 'argon-hash',
      role_id: '4',
      branch_ids: [],
    });
  });

  it('rejects self role changes and empty profile updates', async () => {
    const staffId = '4b450453-7640-4719-990c-29e97b77e3e9';
    const repository = {
      update: vi.fn(),
      assignRole: vi.fn(),
    };
    const service = new StaffService(repository as never);
    await expect(service.update(staffId, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.assignRole(staffId, staffId, '2', false),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.update).not.toHaveBeenCalled();
    expect(repository.assignRole).not.toHaveBeenCalled();
  });

  it('rejects staff branch assignments outside the acting user scope', async () => {
    const staffId = '4b450453-7640-4719-990c-29e97b77e3e9';
    const actorId = 'ad1c7f4c-7181-4877-8c47-2d3b72326a41';
    const repository = { assignBranches: vi.fn() };
    const service = new StaffService(repository as never);

    await expect(
      service.assignBranches(
        staffId,
        actorId,
        ['28af8c76-1e33-4745-a03c-7f7fa2db640a'],
        ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
        false,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.assignBranches).not.toHaveBeenCalled();
  });

  it('passes scoped assignments to storage while preserving the Super Admin replacement path', async () => {
    const staffId = '4b450453-7640-4719-990c-29e97b77e3e9';
    const actorId = 'ad1c7f4c-7181-4877-8c47-2d3b72326a41';
    const branchId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    const otherBranchId = '28af8c76-1e33-4745-a03c-7f7fa2db640a';
    const repository = { assignBranches: vi.fn().mockResolvedValue({ id: staffId }) };
    const service = new StaffService(repository as never);

    await service.assignBranches(staffId, actorId, [branchId], [branchId], false);
    expect(repository.assignBranches).toHaveBeenLastCalledWith(
      staffId,
      [branchId],
      [branchId],
    );

    await service.assignBranches(staffId, actorId, [otherBranchId], [], true);
    expect(repository.assignBranches).toHaveBeenLastCalledWith(
      staffId,
      [otherBranchId],
      undefined,
    );
  });

  it('rejects creating staff with a branch outside the acting user scope', async () => {
    const repository = { create: vi.fn() };
    const service = new StaffService(repository as never);
    await expect(
      service.create(
        {
          email: 'scoped.staff@example.com',
          full_name: 'Scoped Staff',
          contact_number: '09170000000',
          password: 'long test password',
          role_id: '4',
          branch_ids: ['28af8c76-1e33-4745-a03c-7f7fa2db640a'],
        },
        ['3fa85f64-5717-4562-b3fc-2c963f66afa6'],
        false,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.create).not.toHaveBeenCalled();
  });
});
