import { containsSearchPattern } from '../../common/utils/list-filters';
import {
  paginatedResult,
  paginationOffset,
} from '../../common/utils/pagination';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { StockItemQueryDto } from './dto/stock-item-query.dto';

type StockItemListInput = Pick<
  StockItemQueryDto,
  'page' | 'page_size' | 'search' | 'is_active'
>;
type StockItemCreateInput = {
  stock_item_name: string;
  category: string;
  unit: string;
};
type StockItemUpdateInput = Partial<StockItemCreateInput>;

@Injectable()
export class StockItemsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async list(input: StockItemListInput) {
    let records = this.db
      .selectFrom('stock_items')
      .select([
        'id',
        'stock_item_name',
        'category',
        'unit',
        'is_active',
        'created_at',
        'updated_at',
      ])
      .orderBy('stock_item_name')
      .orderBy('id')
      .limit(input.page_size)
      .offset(paginationOffset(input));
    let count = this.db
      .selectFrom('stock_items')
      .select((eb) => eb.fn.countAll<number>().as('total'));

    if (input.search) {
      const pattern = containsSearchPattern(input.search);
      records = records.where('stock_item_name', 'ilike', pattern);
      count = count.where('stock_item_name', 'ilike', pattern);
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

  findById(id: string) {
    return this.db
      .selectFrom('stock_items')
      .select([
        'id',
        'stock_item_name',
        'category',
        'unit',
        'is_active',
        'created_at',
        'updated_at',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  create(input: StockItemCreateInput) {
    return this.db
      .insertInto('stock_items')
      .values(input)
      .returning([
        'id',
        'stock_item_name',
        'category',
        'unit',
        'is_active',
        'created_at',
        'updated_at',
      ])
      .executeTakeFirstOrThrow();
  }

  async update(id: string, patch: StockItemUpdateInput) {
    return this.db.transaction().execute(async (tx) => {
      const existing = await tx
        .selectFrom('stock_items')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!existing) throw new NotFoundException('Stock item not found');
      const stockItem = await tx
        .updateTable('stock_items')
        .set({ ...patch, updated_at: sql<Date>`now()` })
        .where('id', '=', id)
        .returning([
          'id',
          'stock_item_name',
          'category',
          'unit',
          'is_active',
          'created_at',
          'updated_at',
        ])
        .executeTakeFirst();
      if (!stockItem) throw new NotFoundException('Stock item not found');
      return stockItem;
    });
  }

  async deactivate(id: string) {
    return this.db.transaction().execute(async (tx) => {
      // Lock the item first so a concurrent recipe save cannot add it unseen.
      const locked = await tx
        .selectFrom('stock_items')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked) throw new NotFoundException('Stock item not found');
      const recipeProducts = await tx
        .selectFrom('product_ingredients as r')
        .innerJoin('products as p', 'p.id', 'r.product_id')
        .select('p.product_name')
        .distinct()
        .where('r.stock_item_id', '=', id)
        .where('p.is_active', '=', true)
        .orderBy('p.product_name')
        .limit(4)
        .execute();
      if (recipeProducts.length) {
        const names = recipeProducts.slice(0, 3).map((p) => p.product_name);
        const more = recipeProducts.length > 3 ? ' and others' : '';
        throw new ConflictException(
          `Remove this stock item from the recipe of ${names.join(', ')}${more} before deactivating it.`,
        );
      }
      return this.deactivateWith(tx, id);
    });
  }

  private async deactivateWith(executor: Transaction<DB>, id: string) {
    const stockItem = await executor
      .updateTable('stock_items')
      .set({ is_active: false, updated_at: sql<Date>`now()` })
      .where('id', '=', id)
      .returning([
        'id',
        'stock_item_name',
        'category',
        'unit',
        'is_active',
        'created_at',
        'updated_at',
      ])
      .executeTakeFirst();
    if (!stockItem) throw new NotFoundException('Stock item not found');
    return stockItem;
  }
}
