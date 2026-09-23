import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';

export type RecipeIngredientInput = {
  stock_item_id: string;
  quantity_required: string;
};

type DbExecutor = Kysely<DB> | Transaction<DB>;

@Injectable()
export class RecipesRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async findByProductId(productId: string) {
    return this.findDetails(this.db, productId);
  }

  create(productId: string, items: RecipeIngredientInput[]) {
    return this.db.transaction().execute(async (transaction) => {
      const product = await transaction
        .selectFrom('products')
        .select(['id', 'product_name', 'description', 'is_active'])
        .where('id', '=', productId)
        .forUpdate()
        .executeTakeFirst();
      if (!product) throw new NotFoundException('Product not found');
      if (!product.is_active)
        throw new ConflictException('Inactive products cannot have recipes');

      const existing = await transaction
        .selectFrom('product_ingredients')
        .select('stock_item_id')
        .where('product_id', '=', productId)
        .executeTakeFirst();
      if (existing)
        throw new ConflictException('A recipe already exists for this product');

      await this.requireActiveStockItems(transaction, items);
      await transaction
        .insertInto('product_ingredients')
        .values(
          items.map((item) => ({
            product_id: productId,
            stock_item_id: item.stock_item_id,
            quantity_required: item.quantity_required,
          })),
        )
        .execute();

      return this.findDetails(transaction, productId);
    });
  }

  update(productId: string, items: RecipeIngredientInput[]) {
    return this.db.transaction().execute(async (transaction) => {
      const product = await transaction
        .selectFrom('products')
        .select(['id', 'product_name', 'description', 'is_active'])
        .where('id', '=', productId)
        .forUpdate()
        .executeTakeFirst();
      if (!product) throw new NotFoundException('Product not found');
      if (!product.is_active)
        throw new ConflictException('Inactive products cannot have recipes');

      const existing = await transaction
        .selectFrom('product_ingredients')
        .select('stock_item_id')
        .where('product_id', '=', productId)
        .executeTakeFirst();
      if (!existing)
        throw new ConflictException(
          'A recipe must exist before it can be updated',
        );

      await this.requireActiveStockItems(transaction, items);
      await transaction
        .deleteFrom('product_ingredients')
        .where('product_id', '=', productId)
        .execute();
      await transaction
        .insertInto('product_ingredients')
        .values(
          items.map((item) => ({
            product_id: productId,
            stock_item_id: item.stock_item_id,
            quantity_required: item.quantity_required,
          })),
        )
        .execute();

      return this.findDetails(transaction, productId);
    });
  }

  private async requireActiveStockItems(
    transaction: Transaction<DB>,
    items: RecipeIngredientInput[],
  ) {
    const ids = items.map(({ stock_item_id }) => stock_item_id).sort();
    const activeItems = await transaction
      .selectFrom('stock_items')
      .select('id')
      .where('id', 'in', ids)
      .where('is_active', '=', true)
      .orderBy('id')
      .forUpdate()
      .execute();
    if (activeItems.length !== ids.length)
      throw new NotFoundException(
        'One or more active stock items were not found',
      );
  }

  private async findDetails(executor: DbExecutor, productId: string) {
    const product = await executor
      .selectFrom('products')
      .select(['id', 'product_name', 'description', 'is_active'])
      .where('id', '=', productId)
      .executeTakeFirst();
    if (!product) throw new NotFoundException('Product not found');

    const items = await executor
      .selectFrom('product_ingredients as pi')
      .innerJoin('stock_items as si', 'si.id', 'pi.stock_item_id')
      .select([
        'pi.product_id',
        'pi.stock_item_id',
        'si.stock_item_name',
        'si.unit',
        'si.is_active as stock_item_is_active',
        'pi.quantity_required',
        'pi.created_at',
        'pi.updated_at',
      ])
      .where('pi.product_id', '=', productId)
      .orderBy('si.stock_item_name')
      .orderBy('pi.stock_item_id')
      .execute();

    return { product, items };
  }
}
