import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentMethodsController } from './payment-methods.controller';
import { PaymentMethodsService } from './payment-methods.service';
import { PaymentMethodsRepository } from './payment-methods.repository';
@Module({
  imports: [AuthModule],
  controllers: [PaymentMethodsController],
  providers: [PaymentMethodsService, PaymentMethodsRepository],
})
export class PaymentMethodsModule {}
