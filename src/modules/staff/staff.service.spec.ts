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
      service.create({
        email: ' NEW.STAFF@EXAMPLE.COM ',
        full_name: ' New Staff ',
        contact_number: ' 09170000000 ',
        password: 'long test password',
        role_id: '4',
        branch_ids: [],
      }),
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
});
