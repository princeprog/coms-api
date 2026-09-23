import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { BranchProductQueryDto } from './dto/branch-product-query.dto';

type DbExecutor = Kysely<DB> | Transaction<DB>;

@Injectable()
export class BranchProductsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async list(branchId: string, query: BranchProductQueryDto) {
    await this.requireBranch(this.db, branchId);

    let records = this.db
      .selectFrom('branch_products as bp')
      .innerJoin('products as p', 'p.id', 'bp.product_id')
      .select([
        'bp.branch_id',
        'bp.product_id',
        'p.product_name',
        'p.description',
        'p.is_active as product_is_active',
        'bp.price',
        'bp.is_available',
        'bp.created_at',
        'bp.updated_at',
      ])
      .where('bp.branch_id', '=', branchId)
      .orderBy('p.product_name')
      .orderBy('bp.product_id')
      .limit(query.page_size)
      .offset((query.page - 1) * query.page_size);
    let count = this.db
      .selectFrom('branch_products as bp')
      .innerJoin('products as p', 'p.id', 'bp.product_id')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('bp.branch_id', '=', branchId);

    if (query.search) {
      const escapedSearch = query.search.replace(/[\\%_]/g, '\\$&');
      const pattern = `%${escapedSearch}%`;
      records = records.where('p.product_name', 'ilike', pattern);
      count = count.where('p.product_name', 'ilike', pattern);
    }
    if (query.is_available !== undefined) {
      records = records.where('bp.is_available', '=', query.is_available);
      count = count.where('bp.is_available', '=', query.is_available);
    }

    const [items, result] = await Promise.all([
      records.execute(),
      count.executeTakeFirstOrThrow(),
    ]);
    return {
      items,
      total: Number(result.total),
      page: query.page,
      page_size: query.page_size,
    };
  }

  async findByIds(branchId: string, productId: string) {
    const product = await this.db
      .selectFrom('branch_products as bp')
      .innerJoin('branches as b', 'b.id', 'bp.branch_id')
      .innerJoin('products as p', 'p.id', 'bp.product_id')
      .select([
        'bp.branch_id',
        'b.branch_name',
        'bp.product_id',
        'p.product_name',
        'p.description',
        'p.is_active as product_is_active',
        'bp.price',
        'bp.is_available',
        'bp.created_at',
        'bp.updated_at',
      ])
      .where('bp.branch_id', '=', branchId)
      .where('bp.product_id', '=', productId)
      .executeTakeFirst();
    if (!product) throw new NotFoundException('Branch product not found');
    return product;
  }

  create(branchId: string, productId: string, price: string) {
    return this.db.transaction().execute(async (transaction) => {
      await this.requireActiveBranch(transaction, branchId);
      await this.requireActiveProduct(transaction, productId);

      const created = await transaction
        .insertInto('branch_products')
        .values({ branch_id: branchId, product_id: productId, price })
        .onConflict((conflict) =>
          conflict.columns(['branch_id', 'product_id']).doNothing(),
        )
        .returning('product_id')
        .executeTakeFirst();
      if (!created)
        throw new ConflictException(
          'This product is already offered at the branch',
        );

      return this.findByIdsInTransaction(transaction, branchId, productId);
    });
  }

  updatePrice(branchId: string, productId: string, price: string) {
    return this.db.transaction().execute(async (transaction) => {
      await this.requireActiveBranch(transaction, branchId);
      await this.requireActiveProduct(transaction, productId);
      const offering = await transaction
        .selectFrom('branch_products')
        .select(['branch_id', 'product_id'])
        .where('branch_id', '=', branchId)
        .where('product_id', '=', productId)
        .forUpdate()
        .executeTakeFirst();
      if (!offering) throw new NotFoundException('Branch product not found');

      await transaction
        .updateTable('branch_products')
        .set({ price, updated_at: sql<Date>`now()` })
        .where('branch_id', '=', branchId)
        .where('product_id', '=', productId)
        .executeTakeFirstOrThrow();
      return this.findByIdsInTransaction(transaction, branchId, productId);
    });
  }

  updateAvailability(
    branchId: string,
    productId: string,
    isAvailable: boolean,
  ) {
    return this.db.transaction().execute(async (transaction) => {
      await this.requireActiveBranch(transaction, branchId);
      if (isAvailable) await this.requireActiveProduct(transaction, productId);
      const offering = await transaction
        .selectFrom('branch_products')
        .select(['branch_id', 'product_id'])
        .where('branch_id', '=', branchId)
        .where('product_id', '=', productId)
        .forUpdate()
        .executeTakeFirst();
      if (!offering) throw new NotFoundException('Branch product not found');

      await transaction
        .updateTable('branch_products')
        .set({ is_available: isAvailable, updated_at: sql<Date>`now()` })
        .where('branch_id', '=', branchId)
        .where('product_id', '=', productId)
        .executeTakeFirstOrThrow();
      return this.findByIdsInTransaction(transaction, branchId, productId);
    });
  }

  private async findByIdsInTransaction(
    transaction: Transaction<DB>,
    branchId: string,
    productId: string,
  ) {
    const offering = await transaction
      .selectFrom('branch_products as bp')
      .innerJoin('branches as b', 'b.id', 'bp.branch_id')
      .innerJoin('products as p', 'p.id', 'bp.product_id')
      .select([
        'bp.branch_id',
        'b.branch_name',
        'bp.product_id',
        'p.product_name',
        'p.description',
        'p.is_active as product_is_active',
        'bp.price',
        'bp.is_available',
        'bp.created_at',
        'bp.updated_at',
      ])
      .where('bp.branch_id', '=', branchId)
      .where('bp.product_id', '=', productId)
      .executeTakeFirst();
    if (!offering) throw new NotFoundException('Branch product not found');
    return offering;
  }

  private async requireBranch(executor: DbExecutor, branchId: string) {
    const branch = await executor
      .selectFrom('branches')
      .select('id')
      .where('id', '=', branchId)
      .executeTakeFirst();
    if (!branch) throw new NotFoundException('Branch not found');
  }

  private async requireActiveBranch(
    transaction: Transaction<DB>,
    branchId: string,
  ) {
    const branch = await transaction
      .selectFrom('branches')
      .select(['id', 'status'])
      .where('id', '=', branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!branch || branch.status !== 'active')
      throw new NotFoundException('Active branch not found');
  }

  private async requireActiveProduct(
    transaction: Transaction<DB>,
    productId: string,
  ) {
    const product = await transaction
      .selectFrom('products')
      .select(['id', 'is_active'])
      .where('id', '=', productId)
      .forUpdate()
      .executeTakeFirst();
    if (!product) throw new NotFoundException('Product not found');
    if (!product.is_active)
      throw new ConflictException('Inactive products cannot be offered');
  }
}
