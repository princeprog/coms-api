import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import {
  RequireBranchScope,
  RequirePermission,
} from '../../common/decorators/access-policy.decorator';
import type { AccessContext } from '../access-control/access-control.types';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { BranchQueryDto } from './dto/branch-query.dto';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { BranchesService } from './branches.service';

@Controller('branches')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class BranchesController {
  constructor(private readonly service: BranchesService) {}

  @Get()
  @RequirePermission('branches.read')
  list(
    @CurrentAccessContext() access: AccessContext,
    @Query() query: BranchQueryDto,
  ) {
    return this.service.list(access, query);
  }

  @Get(':branchId')
  @RequirePermission('branches.read')
  @RequireBranchScope()
  get(@Param('branchId') id: string) {
    return this.service.get(id);
  }

  @Post()
  @RequirePermission('branches.create')
  create(@Body() dto: CreateBranchDto) {
    return this.service.create(dto);
  }

  @Patch(':branchId')
  @RequirePermission('branches.update')
  @RequireBranchScope()
  update(@Param('branchId') id: string, @Body() dto: UpdateBranchDto) {
    return this.service.update(id, dto);
  }

  @Post(':branchId/deactivate')
  @RequirePermission('branches.deactivate')
  @RequireBranchScope()
  deactivate(@Param('branchId') id: string) {
    return this.service.deactivate(id);
  }
}
