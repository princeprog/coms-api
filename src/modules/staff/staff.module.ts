import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StaffController } from './staff.controller';
import { StaffRepository } from './staff.repository';
import { StaffService } from './staff.service';

@Module({
  imports: [AuthModule],
  controllers: [StaffController],
  providers: [StaffRepository, StaffService],
})
export class StaffModule {}
