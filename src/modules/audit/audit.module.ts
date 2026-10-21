import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditController } from './audit.controller';
import { AuditRepository } from './audit.repository';

@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  providers: [AuditRepository],
})
export class AuditModule {}
