import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { PermissionKey } from '../../modules/access-control/permission-catalog';
import { AccessControlService } from '../../modules/access-control/access-control.service';
import type { AccessContext } from '../../modules/access-control/access-control.types';
import {
  ACCESS_PERMISSION_KEY,
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
    if (!accessContext.role.isActive)
      throw new ForbiddenException('The assigned role is inactive');

    request.accessContext = accessContext;
    const targets = [execution.getHandler(), execution.getClass()];
    const permission = this.reflector.getAllAndOverride<PermissionKey>(
      ACCESS_PERMISSION_KEY,
      targets,
    );
    const branchScoped =
      this.reflector.getAllAndOverride<boolean>(BRANCH_SCOPE_KEY, targets) ===
      true;
    if (!permission && !branchScoped) return true;

    const superAdmin =
      accessContext.role.isSystem && accessContext.role.code === 'SUPER_ADMIN';
    const noAccess =
      accessContext.role.isSystem && accessContext.role.code === 'NO_ACCESS';
    if (permission && !superAdmin) {
      if (noAccess || !accessContext.permissions.includes(permission))
        throw new ForbiddenException('Permission required');
    }
    if (branchScoped && !superAdmin) {
      const branchId = this.requestBranchId(request);
      if (!branchId || !accessContext.branchIds.includes(branchId))
        throw new ForbiddenException('Branch access required');
    }
    return true;
  }

  private requestBranchId(request: AccessRequest): string | undefined {
    const candidates: unknown[] = [
      request.params?.branchId,
      request.query?.branchId,
    ];
    const body = request.body as { branchId?: unknown } | undefined;
    candidates.push(body?.branchId);
    return candidates.find(
      (value): value is string => typeof value === 'string',
    );
  }
}
