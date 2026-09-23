import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/access-policy.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CreateRoleDto } from './dto/create-role.dto';
import { ReplaceRolePermissionsDto } from './dto/replace-role-permissions.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RolesService } from './roles.service';

@Controller('roles')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class RolesController {
  constructor(private readonly service: RolesService) {}

  @Get()
  @RequirePermission('roles.read')
  list() {
    return this.service.list();
  }

  @Get('permissions')
  @RequirePermission('roles.read')
  listPermissions() {
    return this.service.listPermissions();
  }

  @Post()
  @RequirePermission('roles.create')
  create(@Body() dto: CreateRoleDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @RequirePermission('roles.update')
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.service.update(id, dto.role_name);
  }

  @Put(':id/permissions')
  @RequirePermission('roles.permissions_update')
  replacePermissions(
    @Param('id') id: string,
    @Body() dto: ReplaceRolePermissionsDto,
  ) {
    return this.service.replacePermissions(id, dto.permission_keys);
  }

  @Post(':id/deactivate')
  @RequirePermission('roles.deactivate')
  deactivate(@Param('id') id: string) {
    return this.service.deactivate(id);
  }
}
