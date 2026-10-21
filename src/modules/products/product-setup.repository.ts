import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { AccessContext } from '../access-control/access-control.types';
import { decimal, fingerprint, services } from '../../common/utils/menu-rules';
import type { CreateProductDto } from './dto/create-product.dto';
import type { UpdateProductDto } from './dto/update-product.dto';
import type { RecipeUsageScope } from './dto/product-setup.dto';
export type RecipeLineInput = {
  stock_item_id: string;
  quantity: string;
  usage_scope: RecipeUsageScope;
};
export const PRODUCT_COLUMNS = [
  'id',
  'product_name',
  'category_id',
  'description',
  'price',
  'price_revision',
  'service_types',
  'is_active',
  'setup_revision',
  'created_at',
  'updated_at',
  sql<string>`(SELECT name FROM product_categories WHERE id = products.category_id)`.as(
    'category_name',
  ),
  sql<boolean>`(SELECT is_active FROM product_categories WHERE id = products.category_id)`.as(
    'category_is_active',
  ),
  sql<number>`(SELECT count(*)::int FROM product_ingredients WHERE product_id = products.id)`.as(
    'recipe_line_count',
  ),
] as const;
type Executor = Kysely<DB> | Transaction<DB>;
@Injectable()
export class ProductSetupRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}
  async get(id: string, access: AccessContext, executor: Executor = this.db) {
    const product = await executor
      .selectFrom('products')
      .select(PRODUCT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!product) throw new NotFoundException('Product not found');
    let query = executor
      .selectFrom('branch_products')
      .select('branch_id')
      .where('product_id', '=', id)
      .where('is_available', '=', true);
    if (!(access.role?.isSystem && access.role.code === 'SUPER_ADMIN'))
      query = query.where(
        'branch_id',
        'in',
        access.branchIds.length
          ? access.branchIds
          : ['00000000-0000-4000-8000-000000000000'],
      );
    const branches = await query.orderBy('branch_id').execute();
    return {
      product,
      branch_ids: branches.map((b) => b.branch_id),
      recipe: await this.recipe(id, executor),
    };
  }
  private recipe(productId: string, executor: Executor) {
    return executor
      .selectFrom('product_ingredients as r')
      .innerJoin('stock_items as s', 's.id', 'r.stock_item_id')
      .select([
        'r.stock_item_id',
        's.stock_item_name',
        's.unit',
        's.is_active',
        'r.usage_scope',
        sql<string>`trim_scale(r.quantity_required)::text`.as('quantity'),
      ])
      .where('r.product_id', '=', productId)
      .orderBy('s.stock_item_name')
      .orderBy('r.usage_scope')
      .execute();
  }
  async save(
    id: string | undefined,
    input: CreateProductDto | UpdateProductDto,
    expected: number,
    access: AccessContext,
    key?: string,
    recipe?: RecipeLineInput[],
  ) {
    const { expected_product_revision: _revision, ...raw } =
      input as UpdateProductDto;
    const metadata = {
      ...raw,
      ...(raw.price === undefined ? {} : { price: decimal(raw.price) }),
      ...(raw.service_types === undefined
        ? {}
        : { service_types: services(raw.service_types) }),
      ...(raw.branch_ids === undefined
        ? {}
        : { branch_ids: [...raw.branch_ids].sort() }),
    };
    const hash = fingerprint({
      id: id ?? null,
      input: metadata,
      expected,
      ...(recipe === undefined ? {} : { recipe }),
    });
    return this.db.transaction().execute(async (tx) => {
      if (key) {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`.execute(
          tx,
        );
        const prior = await tx
          .selectFrom('product_setup_operations')
          .selectAll()
          .where('idempotency_key', '=', key)
          .executeTakeFirst();
        if (prior) {
          if (
            prior.actor_user_id !== access.userId ||
            prior.fingerprint !== hash
          )
            throw new ConflictException(
              'This retry key belongs to a different product save.',
            );
          const saved = prior.result as unknown as Awaited<
            ReturnType<ProductSetupRepository['get']>
          >;
          // Saves recorded before recipes existed never changed the recipe.
          const recipeLines =
            saved.recipe ?? (await this.recipe(prior.product_id, tx));
          // Old successful retries retain their original result and receive only the
          // newly required category fields; never replay the mutation.
          if (
            !saved.product.category_id ||
            saved.product.category_name === undefined ||
            saved.product.category_is_active === undefined
          ) {
            const category = await tx
              .selectFrom('products as p')
              .innerJoin('product_categories as c', 'c.id', 'p.category_id')
              .select([
                'p.category_id',
                'c.name as category_name',
                'c.is_active as category_is_active',
              ])
              .where('p.id', '=', prior.product_id)
              .executeTakeFirstOrThrow();
            return {
              ...saved,
              recipe: recipeLines,
              product: { ...saved.product, ...category },
            };
          }
          return { ...saved, recipe: recipeLines };
        }
      }
      // Every menu/sale mutation locks branches before products, then offerings.
      const branches = await tx
        .selectFrom('branches')
        .select(['id', 'branch_name', 'status', 'has_dine_in', 'has_takeaway'])
        .orderBy('id')
        .forShare()
        .execute();
      const current = id
        ? await tx
            .selectFrom('products')
            .selectAll()
            .where('id', '=', id)
            .forUpdate()
            .executeTakeFirst()
        : undefined;
      if (id && !current) throw new NotFoundException('Product not found');
      if ((current?.setup_revision ?? 0) !== expected)
        throw new ConflictException(
          'Product changed. Reload and review the current values before saving.',
        );
      const categoryId = metadata.category_id ?? current?.category_id;
      if (!categoryId)
        throw new ConflictException('Select an active product category.');
      const category = await tx
        .selectFrom('product_categories')
        .select(['id', 'is_active'])
        .where('id', '=', categoryId)
        .forShare()
        .executeTakeFirst();
      if (!category) throw new NotFoundException('Product category not found');
      // An inactive legacy product may keep its archived category during an unrelated
      // partial edit; any explicit assignment must select an active category.
      if (
        !category.is_active &&
        (metadata.category_id !== undefined || !current || current.is_active)
      )
        throw new ConflictException('Select an active product category.');
      const selected = metadata.branch_ids;
      const types =
        metadata.service_types ??
        services(current?.service_types ?? ['DINE_IN', 'TAKEAWAY']);
      const price = metadata.price ?? current?.price;
      const name = metadata.product_name?.trim() ?? current?.product_name;
      if (!name || price === undefined)
        throw new ConflictException('Enter a product name and selling price.');
      for (const branchId of selected ?? []) {
        const branch = branches.find((b) => b.id === branchId);
        if (!branch) throw new NotFoundException('Selected branch not found');
        if (branch.status !== 'active')
          throw new ConflictException(`${branch.branch_name} is inactive.`);
        if (
          !types.some((t) =>
            t === 'DINE_IN' ? branch.has_dine_in : branch.has_takeaway,
          )
        )
          throw new ConflictException(
            `${branch.branch_name} does not support the selected services.`,
          );
        if (current && !current.is_active)
          throw new ConflictException(
            'Inactive products cannot be enabled on a branch menu.',
          );
      }
      await this.validateRecipe(tx, current?.id, types, recipe);
      const priceChanged = current && decimal(current.price) !== decimal(price);
      const product = current
        ? await tx
            .updateTable('products')
            .set({
              product_name: name,
              category_id: categoryId,
              description:
                metadata.description === undefined
                  ? current.description
                  : metadata.description?.trim() || null,
              service_types: types,
              price,
              price_revision: current.price_revision + (priceChanged ? 1 : 0),
              setup_revision: current.setup_revision + 1,
              updated_at: sql`now()`,
            })
            .where('id', '=', current.id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : await tx
            .insertInto('products')
            .values({
              product_name: name,
              category_id: categoryId,
              description: metadata.description?.trim() || null,
              service_types: types,
              price,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
      await tx
        .updateTable('branch_products')
        .set({ price: product.price, updated_at: sql`now()` })
        .where('product_id', '=', product.id)
        .execute();
      if (recipe !== undefined) {
        await tx
          .deleteFrom('product_ingredients')
          .where('product_id', '=', product.id)
          .execute();
        if (recipe.length)
          await tx
            .insertInto('product_ingredients')
            .values(
              recipe.map((line) => ({
                product_id: product.id,
                stock_item_id: line.stock_item_id,
                quantity_required: line.quantity,
                usage_scope: line.usage_scope,
                component_type: 'INGREDIENT',
              })),
            )
            .execute();
        await tx
          .updateTable('products')
          .set({ recipe_revision: sql`recipe_revision + 1` })
          .where('id', '=', product.id)
          .execute();
      }
      if (selected !== undefined) {
        await tx
          .updateTable('branch_products')
          .set({ is_available: false, updated_at: sql`now()` })
          .where('product_id', '=', product.id)
          .where(
            'branch_id',
            'not in',
            selected.length
              ? selected
              : ['00000000-0000-4000-8000-000000000000'],
          )
          .execute();
        for (const branchId of selected) {
          const branch = branches.find((b) => b.id === branchId)!;
          const eligible = types.filter((t) =>
            t === 'DINE_IN' ? branch.has_dine_in : branch.has_takeaway,
          );
          const previous = await tx
            .selectFrom('branch_products')
            .select('service_types')
            .where('branch_id', '=', branchId)
            .where('product_id', '=', product.id)
            .forUpdate()
            .executeTakeFirst();
          const retained = previous?.service_types.filter((t) =>
            eligible.includes(t as 'DINE_IN' | 'TAKEAWAY'),
          );
          await tx
            .insertInto('branch_products')
            .values({
              branch_id: branchId,
              product_id: product.id,
              price: product.price,
              is_available: true,
              service_types: retained?.length ? retained : eligible,
            })
            .onConflict((c) =>
              c.columns(['branch_id', 'product_id']).doUpdateSet({
                price: product.price,
                is_available: true,
                service_types: retained?.length ? retained : eligible,
                updated_at: sql`now()`,
              }),
            )
            .execute();
        }
      }
      const result = await this.get(product.id, access, tx);
      if (key)
        await tx
          .insertInto('product_setup_operations')
          .values({
            idempotency_key: key,
            actor_user_id: access.userId,
            product_id: product.id,
            fingerprint: hash,
            result: JSON.stringify(result),
          })
          .execute();
      return JSON.parse(JSON.stringify(result)) as typeof result;
    });
  }
  private async validateRecipe(
    tx: Transaction<DB>,
    productId: string | undefined,
    types: string[],
    recipe: RecipeLineInput[] | undefined,
  ) {
    if (recipe === undefined) {
      if (!productId) return;
      // Narrowing services must not leave lines for a service that is gone.
      const orphaned = await tx
        .selectFrom('product_ingredients')
        .select('stock_item_id')
        .where('product_id', '=', productId)
        .where('usage_scope', '<>', 'ALL')
        .where('usage_scope', 'not in', types)
        .executeTakeFirst();
      if (orphaned)
        throw new ConflictException(
          'Update the recipe: a line applies to a service this product no longer offers.',
        );
      return;
    }
    if (
      recipe.some(
        (l) => l.usage_scope !== 'ALL' && !types.includes(l.usage_scope),
      )
    )
      throw new ConflictException(
        'A recipe line applies to a service this product does not offer.',
      );
    const ids = [...new Set(recipe.map((l) => l.stock_item_id))].sort();
    if (!ids.length) return;
    const stockItems = await tx
      .selectFrom('stock_items')
      .select([
        'id',
        'stock_item_name',
        'is_active',
        sql<boolean>`usage_types && ARRAY['INGREDIENT','PACKAGING','READY_TO_SELL']::text[]`.as(
          'recipe_usable',
        ),
      ])
      .where('id', 'in', ids)
      .orderBy('id')
      .forShare()
      .execute();
    if (stockItems.length !== ids.length)
      throw new NotFoundException('A recipe stock item was not found');
    const inactive = stockItems.find((s) => !s.is_active);
    if (inactive)
      throw new ConflictException(
        `${inactive.stock_item_name} is inactive. Choose an active stock item.`,
      );
    const operating = stockItems.find((s) => !s.recipe_usable);
    if (operating)
      throw new ConflictException(
        `${operating.stock_item_name} is an operating supply and can't be used in recipes.`,
      );
  }
}
