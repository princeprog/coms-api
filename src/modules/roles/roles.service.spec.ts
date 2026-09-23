import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RolesService } from './roles.service';

vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));

describe('RolesService', () => {
  it('creates custom roles with only catalogued permission keys', async () => {
    const repository = {
      create: vi.fn().mockResolvedValue({ id: '9', code: 'STOCK_CLERK' }),
    };
    const service = new RolesService(repository as never);

    await expect(
      service.create({
        code: 'STOCK_CLERK',
        role_name: 'Stock Clerk',
        permission_keys: ['inventory.read'],
      }),
    ).resolves.toEqual({ id: '9', code: 'STOCK_CLERK' });
    expect(repository.create).toHaveBeenCalledWith({
      code: 'STOCK_CLERK',
      role_name: 'Stock Clerk',
      permission_keys: ['inventory.read'],
    });
  });

  it('rejects unknown permission keys and duplicate keys', async () => {
    const repository = { create: vi.fn() };
    const service = new RolesService(repository as never);
    const input = { code: 'STOCK_CLERK', role_name: 'Stock Clerk' };

    expect(() =>
      service.create({ ...input, permission_keys: ['users.delete'] as never }),
    ).toThrow(BadRequestException);
    expect(() =>
      service.create({
        ...input,
        permission_keys: ['inventory.read', 'inventory.read'],
      }),
    ).toThrow(BadRequestException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects invalid role IDs and protects every system role', async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue({
        id: '1',
        code: 'NO_ACCESS',
        is_system: true,
      }),
      updateName: vi.fn(),
      replacePermissions: vi.fn(),
      deactivate: vi.fn(),
    };
    const service = new RolesService(repository as never);
    await expect(service.update('1.0', 'Renamed')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.update('1', '  ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.update('1', 'Renamed')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.replacePermissions('1', [])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.deactivate('1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repository.updateName).not.toHaveBeenCalled();
    expect(repository.replacePermissions).not.toHaveBeenCalled();
    expect(repository.deactivate).not.toHaveBeenCalled();
  });
});
