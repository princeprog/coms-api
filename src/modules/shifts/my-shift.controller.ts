import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import { RequirePermission } from '../../common/decorators/access-policy.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { AccessContext } from '../access-control/access-control.types';
import { ShiftsService } from './shifts.service';

// Not branch-scoped: the header asks "am I on a shift?" before a branch is chosen.
@Controller('shifts')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class MyShiftController {
  constructor(private readonly service: ShiftsService) {}

  @Get('mine')
  @RequirePermission('shifts.read')
  mine(@CurrentAccessContext() access: AccessContext) {
    return this.service.mine(access);
  }
}
