import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  PosOfflineController,
  PosOfflineContextController,
} from './pos-offline.controller';
import { PosOfflineRepository } from './pos-offline.repository';
import { PosOfflineService } from './pos-offline.service';
@Module({
  imports: [AuthModule],
  controllers: [PosOfflineController, PosOfflineContextController],
  providers: [PosOfflineRepository, PosOfflineService],
})
export class PosOfflineModule {}
