import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { ProductQueryDto } from './dto/product-query.dto';

type ProductListInput = Pick<
  ProductQueryDto,
  'page' | 'page_size' | 'search' | 'is_active'
>;
type ProductCreateInput = {
  product_name: string;
  description: string | null;
};
type ProductUpdateInput = Partial<ProductCreateInput>;

@Injectable()
export class ProductsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async list(input: ProductListInput) {
    let records = this.db
      .selectFrom('products')
      .selectAll()
      .orderBy('product_name')
      .orderBy('id')
      .limit(input.page_size)
      .offset((input.page - 1) * input.page_size);
    let count = this.db
      .selectFrom('products')
      .select((eb) => eb.fn.countAll<number>().as('total'));

    if (input.search) {
      const escapedSearch = input.search.replace(/[\\%_]/g, '\\$&');
      const pattern = `%${escapedSearch}%`;
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
    return {
      items,
      total: Number(result.total),
      page: input.page,
      page_size: input.page_size,
    };
  }

  findById(id: string) {
    return this.db
      .selectFrom('products')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  create(input: ProductCreateInput) {
    return this.db
      .insertInto('products')
      .values(input)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(id: string, patch: ProductUpdateInput) {
    const product = await this.db
      .updateTable('products')
      .set({ ...patch, updated_at: sql<Date>`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async deactivate(id: string) {
    const product = await this.db
      .updateTable('products')
      .set({ is_active: false, updated_at: sql<Date>`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }
}
