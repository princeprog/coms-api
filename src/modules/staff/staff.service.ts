import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hashPassword } from '../auth/password-hashing';
import { StaffRepository } from './staff.repository';

const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLE_ID_PATTERN = /^[1-9]\d{0,18}$/;

@Injectable()
export class StaffService {
  constructor(private readonly repository: StaffRepository) {}

  list(query: { page: number; page_size: number; search?: string }) {
    return this.repository.list(query.page, query.page_size, query.search);
  }

  async get(id: string) {
    this.validateUserId(id);
    const member = await this.repository.findById(id);
    if (!member) throw new NotFoundException('Staff account not found');
    return member;
  }

  async create(
    input: {
      email: string;
      full_name: string;
      contact_number: string;
      password: string;
      role_id: string;
      branch_ids: string[];
    },
    actorBranchIds: string[],
    actorIsSuperAdmin: boolean,
  ) {
    const email = input.email.trim().toLowerCase();
    const fullName = input.full_name.trim();
    const contactNumber = input.contact_number.trim();
    this.validateRoleId(input.role_id);
    this.validateBranches(input.branch_ids);
    if (!actorIsSuperAdmin && actorBranchIds.length === 0)
      throw new ForbiddenException('Branch access required');
    if (
      !actorIsSuperAdmin &&
      input.branch_ids.some((branchId) => !actorBranchIds.includes(branchId))
    )
      throw new ForbiddenException(
        'You cannot assign staff outside your branch access',
      );
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new BadRequestException('A valid staff email is required');
    if (fullName.length < 2 || fullName.length > 160)
      throw new BadRequestException('Staff name must be 2 to 160 characters');
    if (contactNumber.length < 7 || contactNumber.length > 30)
      throw new BadRequestException(
        'Contact number must be 7 to 30 characters',
      );
    if (input.password.length < 12 || input.password.length > 128)
      throw new BadRequestException('Password must be 12 to 128 characters');
    return this.repository.create({
      email,
      full_name: fullName,
      contact_number: contactNumber,
      hashed_password: await hashPassword(input.password),
      role_id: input.role_id,
      branch_ids: input.branch_ids,
    });
  }

  async update(
    id: string,
    input: { email?: string; full_name?: string; contact_number?: string },
  ) {
    this.validateUserId(id);
    if (Object.keys(input).length === 0)
      throw new BadRequestException('At least one staff field is required');
    const patch: typeof input = {};
    if (input.email !== undefined) {
      const email = input.email.trim().toLowerCase();
      if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new BadRequestException('A valid staff email is required');
      patch.email = email;
    }
    if (input.full_name !== undefined) {
      const fullName = input.full_name.trim();
      if (fullName.length < 2 || fullName.length > 160)
        throw new BadRequestException('Staff name must be 2 to 160 characters');
      patch.full_name = fullName;
    }
    if (input.contact_number !== undefined) {
      const contactNumber = input.contact_number.trim();
      if (contactNumber.length < 7 || contactNumber.length > 30)
        throw new BadRequestException(
          'Contact number must be 7 to 30 characters',
        );
      patch.contact_number = contactNumber;
    }
    return this.repository.update(id, patch);
  }

  async assignRole(
    id: string,
    actorId: string,
    roleId: string,
    actorIsSuperAdmin: boolean,
  ) {
    this.validateUserId(id);
    this.validateUserId(actorId);
    this.validateRoleId(roleId);
    if (id === actorId)
      throw new ForbiddenException('You cannot change your own role');
    return this.repository.assignRole(id, roleId, actorIsSuperAdmin);
  }

  async assignBranches(
    id: string,
    actorId: string,
    branchIds: string[],
    actorBranchIds: string[],
    actorIsSuperAdmin: boolean,
  ) {
    this.validateUserId(id);
    this.validateUserId(actorId);
    this.validateBranches(branchIds);
    if (id === actorId)
      throw new ForbiddenException('You cannot change your own branch access');
    if (!actorIsSuperAdmin && actorBranchIds.length === 0)
      throw new ForbiddenException('Branch access required');
    if (
      !actorIsSuperAdmin &&
      branchIds.some((branchId) => !actorBranchIds.includes(branchId))
    )
      throw new ForbiddenException(
        'You cannot assign staff outside your branch access',
      );
    return this.repository.assignBranches(
      id,
      branchIds,
      actorIsSuperAdmin ? undefined : actorBranchIds,
    );
  }

  async deactivate(id: string, actorId: string, actorIsSuperAdmin: boolean) {
    this.validateUserId(id);
    this.validateUserId(actorId);
    if (id === actorId)
      throw new ForbiddenException('You cannot deactivate your own account');
    return this.repository.deactivate(id, actorIsSuperAdmin);
  }

  private validateUserId(id: string): void {
    if (!USER_ID_PATTERN.test(id))
      throw new BadRequestException('User ID must be a UUID');
  }

  private validateRoleId(id: string): void {
    if (!ROLE_ID_PATTERN.test(id) || BigInt(id) > 9_223_372_036_854_775_807n)
      throw new BadRequestException('Role ID must be a positive integer');
  }

  private validateBranches(branchIds: string[]): void {
    if (
      !Array.isArray(branchIds) ||
      branchIds.length > 100 ||
      new Set(branchIds).size !== branchIds.length ||
      branchIds.some((id) => !USER_ID_PATTERN.test(id))
    )
      throw new BadRequestException('Branch IDs must be unique UUIDs');
  }
}
