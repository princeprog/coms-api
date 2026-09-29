import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { AccessContext } from '../access-control/access-control.types';
import type { BranchQueryDto } from './dto/branch-query.dto';
import { BranchesRepository } from './branches.repository';

@Injectable()
export class BranchesService {
  constructor(private readonly repository: BranchesRepository) {}

  list(access: AccessContext, query: BranchQueryDto) {
    const isSuperAdmin =
      access.role?.isSystem === true && access.role.code === 'SUPER_ADMIN';
    return this.repository.list(
      query.page,
      query.page_size,
      isSuperAdmin ? undefined : access.branchIds,
    );
  }

  async get(id: string) {
    const branch = await this.repository.findById(id);
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  async create(
    input: Omit<Parameters<BranchesRepository['create']>[0], 'code'>,
  ) {
    const branchName = input.branch_name.trim();
    if (branchName.length < 2)
      throw new BadRequestException(
        'Branch name must contain at least 2 characters',
      );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = `BR-${randomBytes(8).toString('hex').toUpperCase()}`;
      try {
        return await this.repository.create({
          ...input,
          branch_name: branchName,
          code,
        });
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
      }
    }
    throw new ServiceUnavailableException(
      'Could not create branch. Try again.',
    );
  }

  async update(id: string, input: Parameters<BranchesRepository['update']>[1]) {
    if (Object.keys(input).length === 0)
      throw new BadRequestException('At least one branch field is required');
    if (input.branch_name !== undefined && input.branch_name.trim().length < 2)
      throw new BadRequestException(
        'Branch name must contain at least 2 characters',
      );
    return this.repository.update(id, input);
  }

  deactivate(id: string) {
    return this.repository.deactivate(id);
  }
}
