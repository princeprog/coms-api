import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import {
  RequireBranchScope,
  RequirePermission,
} from '../../common/decorators/access-policy.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CreateStaffDto } from './dto/create-staff.dto';
import { StaffBranchQueryDto } from './dto/staff-branch-query.dto';
import { AssignStaffBranchesDto } from './dto/assign-staff-branches.dto';
import { AssignStaffRoleDto } from './dto/assign-staff-role.dto';
import { StaffQueryDto } from './dto/staff-query.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { StaffService } from './staff.service';
import type { AccessContext } from '../access-control/access-control.types';

type RequestUser = { id: string };

@Controller('staff')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class StaffController {
  constructor(private readonly service: StaffService) {}

  @Get()
  @RequirePermission('staff.read')
  @RequireBranchScope()
  list(
    @CurrentAccessContext() access: AccessContext,
    @Query() query: StaffQueryDto,
  ) {
    return this.service.list(
      query,
      access.branchIds,
      access.role.isSystem && access.role.code === 'SUPER_ADMIN',
    );
  }

  @Get(':userId')
  @RequirePermission('staff.read')
  @RequireBranchScope()
  get(
    @Param('userId') userId: string,
    @Query() scope: StaffBranchQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.get(
      userId,
      scope.branch_id,
      access.branchIds,
      access.role.isSystem && access.role.code === 'SUPER_ADMIN',
    );
  }

  @Post()
  @RequirePermission('staff.create')
  @RequireBranchScope()
  create(
    @CurrentAccessContext() access: AccessContext,
    @Body() dto: CreateStaffDto,
  ) {
    return this.service.create(
      dto,
      access.branchIds,
      access.role.isSystem && access.role.code === 'SUPER_ADMIN',
    );
  }

  @Patch(':userId')
  @RequirePermission('staff.update')
  @RequireBranchScope()
  update(
    @Param('userId') userId: string,
    @Query() scope: StaffBranchQueryDto,
    @CurrentAccessContext() access: AccessContext,
    @Body() dto: UpdateStaffDto,
  ) {
    return this.service.update(
      userId,
      dto,
      scope.branch_id,
      access.branchIds,
      access.role.isSystem && access.role.code === 'SUPER_ADMIN',
    );
  }

  @Put(':userId/role')
  @RequirePermission('staff.role_assign')
  @RequireBranchScope()
  assignRole(
    @Param('userId') userId: string,
    @CurrentUser() actor: RequestUser,
    @Query() scope: StaffBranchQueryDto,
    @CurrentAccessContext() access: AccessContext,
    @Body() dto: AssignStaffRoleDto,
  ) {
    return this.service.assignRole(
      userId,
      actor.id,
      dto.role_id,
      scope.branch_id,
      access.branchIds,
      access.role.isSystem && access.role.code === 'SUPER_ADMIN',
    );
  }

  @Put(':userId/branches')
  @RequirePermission('staff.branch_assign')
  @RequireBranchScope()
  assignBranches(
    @Param('userId') userId: string,
    @CurrentUser() actor: RequestUser,
    @Query() scope: StaffBranchQueryDto,
    @CurrentAccessContext() access: AccessContext,
    @Body() dto: AssignStaffBranchesDto,
  ) {
    return this.service.assignBranches(
      userId,
      actor.id,
      dto.branch_ids,
      access.branchIds,
      access.role.isSystem && access.role.code === 'SUPER_ADMIN',
      scope.branch_id,
    );
  }

  @Post(':userId/deactivate')
  @RequirePermission('staff.deactivate')
  @RequireBranchScope()
  deactivate(
    @Param('userId') userId: string,
    @CurrentUser() actor: RequestUser,
    @Query() scope: StaffBranchQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.deactivate(
      userId,
      actor.id,
      scope.branch_id,
      access.branchIds,
      access.role.isSystem && access.role.code === 'SUPER_ADMIN',
    );
  }
}
