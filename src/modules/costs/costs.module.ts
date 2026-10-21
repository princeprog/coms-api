import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CostsController } from './costs.controller';
import { CostsRepository } from './costs.repository';
import { CostsService } from './costs.service';

@Module({
  imports: [AuthModule],
  controllers: [CostsController],
  providers: [CostsRepository, CostsService],
  exports: [CostsService],
})
export class CostsModule {}
