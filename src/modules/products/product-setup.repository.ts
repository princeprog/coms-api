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
export const PRODUCT_COLUMNS = [
  'id',
  'product_name',
  'description',
  'price',
  'price_revision',
  'service_types',
  'is_active',
  'setup_revision',
  'created_at',
  'updated_at',
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
    return { product, branch_ids: branches.map((b) => b.branch_id) };
  }
  async save(
    id: string | undefined,
    input: CreateProductDto | UpdateProductDto,
    expected: number,
    access: AccessContext,
    key?: string,
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
    const hash = fingerprint({ id: id ?? null, input: metadata, expected });
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
          return prior.result as unknown as Awaited<
            ReturnType<ProductSetupRepository['get']>
          >;
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
      const priceChanged = current && decimal(current.price) !== decimal(price);
      const product = current
        ? await tx
            .updateTable('products')
            .set({
              product_name: name,
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
}
