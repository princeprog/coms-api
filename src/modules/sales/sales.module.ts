import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SalesController } from './sales.controller';
import { SalesRepository } from './sales.repository';
import { SalesService } from './sales.service';

@Module({
  imports: [AuthModule],
  controllers: [SalesController],
  providers: [SalesRepository, SalesService],
})
export class SalesModule {}
