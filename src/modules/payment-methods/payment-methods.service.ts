import { ConflictException, Injectable } from '@nestjs/common';
import { PaymentMethodsRepository } from './payment-methods.repository';
import type {
  PaymentMethodQueryDto,
  SavePaymentMethodDto,
} from './dto/payment-method.dto';

@Injectable()
export class PaymentMethodsService {
  constructor(private readonly repository: PaymentMethodsRepository) {}
  list(query: PaymentMethodQueryDto) {
    return this.repository.list(query);
  }
  available() {
    return this.repository.available();
  }
  async save(input: SavePaymentMethodDto, id?: string) {
    try {
      return await (id
        ? this.repository.update(id, input)
        : this.repository.create(input));
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23505'
      )
        throw new ConflictException(
          'A payment method with this name already exists. Edit or reactivate it instead.',
        );
      throw error;
    }
  }
  deactivate(id: string) {
    return this.repository.update(id, { is_active: false });
  }
}
