import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import { containsSearchPattern } from '../../common/utils/list-filters';
import {
  paginatedResult,
  paginationOffset,
} from '../../common/utils/pagination';
import type {
  CreateProductCategoryDto,
  ProductCategoryQueryDto,
  UpdateProductCategoryDto,
} from './dto/product-category.dto';

@Injectable()
export class ProductCategoriesRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}
  async list(input: ProductCategoryQueryDto) {
    let query = this.db.selectFrom('product_categories');
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
  create(input: CreateProductCategoryDto) {
    return this.db
      .insertInto('product_categories')
      .values(input)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  // Hold the category lock through the service's decision and update. Product saves
  // acquire a shared lock on the same row before assigning it.
  withLocked<T>(id: string, action: (tx: Transaction<DB>) => Promise<T>) {
    return this.db.transaction().execute(async (tx) => {
      const category = await tx
        .selectFrom('product_categories')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!category) throw new NotFoundException('Product category not found');
      return action(tx);
    });
  }
  async hasActiveProducts(id: string, tx: Transaction<DB>) {
    return !!(await tx
      .selectFrom('products')
      .select('id')
      .where('category_id', '=', id)
      .where('is_active', '=', true)
      .executeTakeFirst());
  }
  update(id: string, input: UpdateProductCategoryDto, tx: Transaction<DB>) {
    return tx
      .updateTable('product_categories')
      .set({
        name: input.name,
        is_active: input.is_active,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
