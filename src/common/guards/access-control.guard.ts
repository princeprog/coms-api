import {
  CanActivate,
  ExecutionContext,
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { isUUID } from 'class-validator';
import type { PermissionKey } from '../../modules/access-control/permission-catalog';
import { AccessControlService } from '../../modules/access-control/access-control.service';
import type { AccessContext } from '../../modules/access-control/access-control.types';
import {
  ACCESS_PERMISSION_KEY,
  ALLOW_UNASSIGNED_ROLE_KEY,
  BRANCH_SCOPE_KEY,
} from '../decorators/access-policy.decorator';

type AccessRequest = Request & {
  user?: { id: string };
  accessContext?: AccessContext;
};

@Injectable()
export class AccessControlGuard implements CanActivate {
  constructor(
    private readonly accessControl: AccessControlService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const request = execution.switchToHttp().getRequest<AccessRequest>();
    if (!request.user?.id)
      throw new UnauthorizedException('Authentication required');

    const accessContext = await this.accessControl.findAccessContext(
      request.user.id,
    );
    if (!accessContext || !accessContext.accountActive)
      throw new UnauthorizedException('Authentication required');
    request.accessContext = accessContext;
    const targets = [execution.getHandler(), execution.getClass()];
    const allowUnassignedRole =
      this.reflector.getAllAndOverride<boolean>(
        ALLOW_UNASSIGNED_ROLE_KEY,
        targets,
      ) === true;
    const permission = this.reflector.getAllAndOverride<PermissionKey>(
      ACCESS_PERMISSION_KEY,
      targets,
    );
    const branchScoped =
      this.reflector.getAllAndOverride<boolean>(BRANCH_SCOPE_KEY, targets) ===
      true;
    if (!accessContext.role) {
      if (!allowUnassignedRole || permission || branchScoped)
        throw new ForbiddenException('An active role is required');
      return true;
    }
    if (!accessContext.role.isActive)
      throw new ForbiddenException('The assigned role is inactive');

    if (!permission && !branchScoped) return true;

    const superAdmin =
      accessContext.role.isSystem && accessContext.role.code === 'SUPER_ADMIN';
    if (permission && !superAdmin) {
      if (!accessContext.permissions.includes(permission))
        throw new ForbiddenException('Permission required');
    }
    if (branchScoped && !superAdmin) {
      const branchIds = this.requestBranchIds(request);
      if (branchIds.some((branchId) => !isUUID(branchId)))
        throw new BadRequestException('Branch identifiers must be UUIDs');
      const body = request.body as { branch_ids?: unknown } | undefined;
      const requestedBranchList = Array.isArray(body?.branch_ids)
        ? body.branch_ids
        : undefined;
      const branchListProvided = requestedBranchList !== undefined;
      const hasInvalidBranchList =
        requestedBranchList?.some((branchId) => typeof branchId !== 'string') ??
        false;
      if (
        (!branchIds.length && !branchListProvided) ||
        hasInvalidBranchList ||
        (branchListProvided &&
          branchIds.length === 0 &&
          accessContext.branchIds.length === 0) ||
        branchIds.some(
          (branchId) => !accessContext.branchIds.includes(branchId),
        )
      )
        throw new ForbiddenException('Branch access required');
    }
    return true;
  }

  private requestBranchIds(request: AccessRequest): string[] {
    const candidates: unknown[] = [
      request.params?.branchId,
      request.params?.branch_id,
      request.query?.branchId,
      request.query?.branch_id,
    ];
    const body = request.body as
      | { branchId?: unknown; branch_id?: unknown; branch_ids?: unknown }
      | undefined;
    candidates.push(body?.branchId, body?.branch_id);
    if (Array.isArray(body?.branch_ids)) candidates.push(...body.branch_ids);
    return candidates.filter(
      (value): value is string => typeof value === 'string',
    );
  }
}
