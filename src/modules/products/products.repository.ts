import { containsSearchPattern } from '../../common/utils/list-filters';
import {
  paginatedResult,
  paginationOffset,
} from '../../common/utils/pagination';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { ProductQueryDto } from './dto/product-query.dto';
import { PRODUCT_COLUMNS } from './product-setup.repository';

type ProductListInput = Pick<
  ProductQueryDto,
  'page' | 'page_size' | 'search' | 'is_active'
>;

@Injectable()
export class ProductsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async list(input: ProductListInput) {
    let records = this.db
      .selectFrom('products')
      .select(PRODUCT_COLUMNS)
      .orderBy('product_name')
      .orderBy('id')
      .limit(input.page_size)
      .offset(paginationOffset(input));
    let count = this.db
      .selectFrom('products')
      .select((eb) => eb.fn.countAll<number>().as('total'));

    if (input.search) {
      const pattern = containsSearchPattern(input.search);
      records = records.where('product_name', 'ilike', pattern);
      count = count.where('product_name', 'ilike', pattern);
    }
    if (input.is_active !== undefined) {
      records = records.where('is_active', '=', input.is_active);
      count = count.where('is_active', '=', input.is_active);
    }

    const [items, result] = await Promise.all([
      records.execute(),
      count.executeTakeFirstOrThrow(),
    ]);
    return paginatedResult(items, Number(result.total), input);
  }

  async findById(id: string) {
    return this.db
      .selectFrom('products')
      .select(PRODUCT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirstOrThrow(
        () => new NotFoundException('Product not found'),
      );
  }

  async deactivate(id: string) {
    const product = await this.db
      .updateTable('products')
      .set({
        is_active: false,
        setup_revision: sql`setup_revision+1`,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', id)
      .returning(PRODUCT_COLUMNS)
      .executeTakeFirst();
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }
}
