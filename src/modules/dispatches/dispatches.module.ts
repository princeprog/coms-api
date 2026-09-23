import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DispatchesController } from './dispatches.controller';
import { DispatchDraftsRepository } from './dispatch-drafts.repository';
import { DispatchPostingRepository } from './dispatch-posting.repository';
import { DispatchReceivingRepository } from './dispatch-receiving.repository';
import { DispatchesRepository } from './dispatches.repository';
import { DispatchesService } from './dispatches.service';

@Module({
  imports: [AuthModule],
  controllers: [DispatchesController],
  providers: [
    DispatchesRepository,
    DispatchDraftsRepository,
    DispatchPostingRepository,
    DispatchReceivingRepository,
    DispatchesService,
  ],
})
export class DispatchesModule {}
