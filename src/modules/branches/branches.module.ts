import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BranchesController } from './branches.controller';
import { BranchesRepository } from './branches.repository';
import { BranchesService } from './branches.service';

@Module({
  imports: [AuthModule],
  controllers: [BranchesController],
  providers: [BranchesRepository, BranchesService],
})
export class BranchesModule {}
