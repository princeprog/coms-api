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
import type { StockRecipeUse } from './dto/create-stock-item.dto';

type StockItemListInput = Pick<
  StockItemQueryDto,
  'page' | 'page_size' | 'search' | 'is_active' | 'recipe_use'
>;
type StockItemCreateInput = {
  stock_item_name: string;
  category: string;
  unit: string;
  recipe_use: StockRecipeUse;
  daily_count_required: boolean;
};
type StockItemUpdateInput = Partial<StockItemCreateInput>;

// usage_types keeps the earlier detailed classification; the product only needs
// to know whether an item may appear in recipes.
const RECIPE_USAGES = sql`ARRAY['INGREDIENT','PACKAGING','READY_TO_SELL']::text[]`;
const STOCK_ITEM_COLUMNS = [
  'id',
  'stock_item_name',
  'category',
  'unit',
  'is_active',
  'daily_count_required',
  'created_at',
  'updated_at',
  sql<StockRecipeUse>`CASE WHEN usage_types && ${RECIPE_USAGES} THEN 'RECIPE' ELSE 'OPERATING_SUPPLY' END`.as(
    'recipe_use',
  ),
] as const;
const usageTypes = (use: StockRecipeUse) =>
  use === 'RECIPE' ? ['INGREDIENT'] : ['OPERATING_SUPPLY'];

@Injectable()
export class StockItemsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async list(input: StockItemListInput) {
    let records = this.db
      .selectFrom('stock_items')
      .select(STOCK_ITEM_COLUMNS)
      .orderBy('stock_item_name')
      .orderBy('id')
      .limit(input.page_size)
      .offset(paginationOffset(input));
    let count = this.db
      .selectFrom('stock_items')
      .select((eb) => eb.fn.countAll<number>().as('total'));

    if (input.search) {
      const pattern = containsSearchPattern(input.search);
      records = records.where((eb) =>
        eb.or([
          eb('stock_item_name', 'ilike', pattern),
          eb('category', 'ilike', pattern),
        ]),
      );
      count = count.where((eb) =>
        eb.or([
          eb('stock_item_name', 'ilike', pattern),
          eb('category', 'ilike', pattern),
        ]),
      );
    }
    if (input.is_active !== undefined) {
      records = records.where('is_active', '=', input.is_active);
      count = count.where('is_active', '=', input.is_active);
    }
    if (input.recipe_use) {
      const usable = sql<boolean>`usage_types && ${RECIPE_USAGES}`;
      const condition =
        input.recipe_use === 'RECIPE' ? usable : sql<boolean>`NOT (${usable})`;
      records = records.where(condition);
      count = count.where(condition);
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
      .select(STOCK_ITEM_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  create({ recipe_use, ...input }: StockItemCreateInput) {
    return this.db
      .insertInto('stock_items')
      .values({ ...input, usage_types: usageTypes(recipe_use) })
      .returning(STOCK_ITEM_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  async update(id: string, { recipe_use, ...patch }: StockItemUpdateInput) {
    return this.db.transaction().execute(async (tx) => {
      await this.lock(tx, id);
      if (recipe_use === 'OPERATING_SUPPLY')
        await this.requireNoActiveRecipe(
          tx,
          id,
          'marking it an operating supply',
        );
      const stockItem = await tx
        .updateTable('stock_items')
        .set({
          ...patch,
          ...(recipe_use ? { usage_types: usageTypes(recipe_use) } : {}),
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', id)
        .returning(STOCK_ITEM_COLUMNS)
        .executeTakeFirst();
      if (!stockItem) throw new NotFoundException('Stock item not found');
      return stockItem;
    });
  }

  async deactivate(id: string) {
    return this.db.transaction().execute(async (tx) => {
      await this.lock(tx, id);
      await this.requireNoActiveRecipe(tx, id, 'deactivating it');
      const stockItem = await tx
        .updateTable('stock_items')
        .set({ is_active: false, updated_at: sql<Date>`now()` })
        .where('id', '=', id)
        .returning(STOCK_ITEM_COLUMNS)
        .executeTakeFirst();
      if (!stockItem) throw new NotFoundException('Stock item not found');
      return stockItem;
    });
  }

  // Lock the item first so a concurrent recipe save cannot add it unseen.
  private async lock(tx: Transaction<DB>, id: string) {
    const locked = await tx
      .selectFrom('stock_items')
      .select('id')
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!locked) throw new NotFoundException('Stock item not found');
  }

  private async requireNoActiveRecipe(
    tx: Transaction<DB>,
    id: string,
    action: string,
  ) {
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
    if (!recipeProducts.length) return;
    const names = recipeProducts.slice(0, 3).map((p) => p.product_name);
    const more = recipeProducts.length > 3 ? ' and others' : '';
    throw new ConflictException(
      `Remove this stock item from the recipe of ${names.join(', ')}${more} before ${action}.`,
    );
  }
}
