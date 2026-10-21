import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/access-policy.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AuditRepository } from './audit.repository';
import { AuditQueryDto } from './dto/audit-query.dto';

@Controller('audit-events')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class AuditController {
  constructor(private readonly repository: AuditRepository) {}

  @Get()
  @RequirePermission('audit.read')
  list(@Query() query: AuditQueryDto) {
    return this.repository.list(query);
  }
}
