import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
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
      .selectAll()
      .orderBy('stock_item_name')
      .orderBy('id')
      .limit(input.page_size)
      .offset((input.page - 1) * input.page_size);
    let count = this.db
      .selectFrom('stock_items')
      .select((eb) => eb.fn.countAll<number>().as('total'));

    if (input.search) {
      const escapedSearch = input.search.replace(/[\\%_]/g, '\\$&');
      const pattern = `%${escapedSearch}%`;
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
    return {
      items,
      total: Number(result.total),
      page: input.page,
      page_size: input.page_size,
    };
  }

  findById(id: string) {
    return this.db
      .selectFrom('stock_items')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  create(input: StockItemCreateInput) {
    return this.db
      .insertInto('stock_items')
      .values(input)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(id: string, patch: StockItemUpdateInput) {
    const stockItem = await this.db
      .updateTable('stock_items')
      .set({ ...patch, updated_at: sql<Date>`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!stockItem) throw new NotFoundException('Stock item not found');
    return stockItem;
  }

  async deactivate(id: string) {
    const stockItem = await this.db
      .updateTable('stock_items')
      .set({ is_active: false, updated_at: sql<Date>`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!stockItem) throw new NotFoundException('Stock item not found');
    return stockItem;
  }
}
