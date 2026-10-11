import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import { containsSearchPattern } from '../../common/utils/list-filters';
import {
  paginatedResult,
  paginationOffset,
} from '../../common/utils/pagination';
import type {
  PaymentMethodQueryDto,
  SavePaymentMethodDto,
} from './dto/payment-method.dto';

@Injectable()
export class PaymentMethodsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async list(input: PaymentMethodQueryDto) {
    let query = this.db.selectFrom('payment_methods');
    if (input.search)
      query = query.where('name', 'ilike', containsSearchPattern(input.search));
    if (input.is_active !== undefined)
      query = query.where('is_active', '=', input.is_active);
    const [items, count] = await Promise.all([
      query
        .selectAll()
        .orderBy('name')
        .orderBy('id')
        .limit(input.page_size)
        .offset(paginationOffset(input))
        .execute(),
      query
        .select((eb) => eb.fn.countAll<number>().as('total'))
        .executeTakeFirstOrThrow(),
    ]);
    return paginatedResult(items, Number(count.total), input);
  }

  available() {
    return this.db
      .selectFrom('payment_methods')
      .select(['id', 'name', 'kind'])
      .where('is_active', '=', true)
      .orderBy('name')
      .orderBy('id')
      .execute();
  }

  create(input: SavePaymentMethodDto) {
    return this.db
      .insertInto('payment_methods')
      .values(input)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(id: string, input: Partial<SavePaymentMethodDto>) {
    const result = await this.db
      .updateTable('payment_methods')
      .set({ ...input, updated_at: sql<Date>`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!result) throw new NotFoundException('Payment method not found');
    return result;
  }
}
