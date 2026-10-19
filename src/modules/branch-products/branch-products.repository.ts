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
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { BranchProductQueryDto } from './dto/branch-product-query.dto';
import { services } from '../../common/utils/menu-rules';
const eligible = sql<
  string[]
>`ARRAY(SELECT s FROM unnest(p.service_types) s WHERE (s='DINE_IN' AND b.has_dine_in) OR (s='TAKEAWAY' AND b.has_takeaway))`;
const available = sql<
  string[]
>`ARRAY(SELECT s FROM unnest(bp.service_types) s WHERE p.is_active AND b.status='active' AND s=ANY(p.service_types) AND ((s='DINE_IN' AND b.has_dine_in) OR (s='TAKEAWAY' AND b.has_takeaway)))`;
@Injectable()
export class BranchProductsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}
  private query() {
    return this.db
      .selectFrom('branch_products as bp')
      .innerJoin('products as p', 'p.id', 'bp.product_id')
      .innerJoin('branches as b', 'b.id', 'bp.branch_id')
      .innerJoin('product_categories as c', 'c.id', 'p.category_id');
  }
  private columns() {
    return [
      'bp.branch_id',
      'b.branch_name',
      'bp.product_id',
      'p.product_name',
      'p.category_id',
      'c.name as category_name',
      'c.is_active as category_is_active',
      'p.description',
      'p.is_active as product_is_active',
      sql<string>`trim_scale(p.price)::text`.as('price'),
      'p.price_revision',
      'bp.service_types',
      'p.service_types as product_service_types',
      'bp.is_available',
      'bp.created_at',
      'bp.updated_at',
      eligible.as('eligible_service_types'),
      available.as('available_service_types'),
      sql<
        string | null
      >`CASE WHEN b.status<>'active' THEN 'Inactive branch' WHEN NOT p.is_active THEN 'Inactive product' WHEN cardinality(${available})=0 THEN 'Unsupported service' ELSE NULL END`.as(
        'blocked_reason',
      ),
    ] as const;
  }
  async list(branchId: string, query: BranchProductQueryDto) {
    const branch = await this.db
      .selectFrom('branches')
      .select('id')
      .where('id', '=', branchId)
      .executeTakeFirst();
    if (!branch) throw new NotFoundException('Branch not found');
    let base = this.query().where('bp.branch_id', '=', branchId);
    if (query.category_id)
      base = base.where('p.category_id', '=', query.category_id);
    if (query.search)
      base = base.where(
        'p.product_name',
        'ilike',
        containsSearchPattern(query.search),
      );
    if (query.is_available !== undefined)
      base = base.where('bp.is_available', '=', query.is_available);
    if (query.service_type)
      base = base.where(sql<boolean>`${query.service_type}=ANY(${available})`);
    if (query.eligible_only)
      base = base
        .where('bp.is_available', '=', true)
        .where(sql<boolean>`cardinality(${available})>0`);
    const sort =
      query.sort_by === 'price'
        ? 'p.price'
        : query.sort_by === 'created_at'
          ? 'bp.created_at'
          : 'p.product_name';
    const [items, count] = await Promise.all([
      base
        .select(this.columns())
        .orderBy(sort, query.sort_order ?? 'asc')
        .orderBy('bp.product_id')
        .limit(query.page_size)
        .offset(paginationOffset(query))
        .execute(),
      base
        .select((eb) => eb.fn.countAll<number>().as('total'))
        .executeTakeFirstOrThrow(),
    ]);
    return paginatedResult(items, Number(count.total), query);
  }
  async categories(branchId: string, serviceType?: 'DINE_IN' | 'TAKEAWAY') {
    const branch = await this.db
      .selectFrom('branches')
      .select('id')
      .where('id', '=', branchId)
      .executeTakeFirst();
    if (!branch) throw new NotFoundException('Branch not found');
    let query = this.query()
      .where('bp.branch_id', '=', branchId)
      .where('bp.is_available', '=', true)
      .where('c.is_active', '=', true)
      .where(sql<boolean>`cardinality(${available})>0`);
    if (serviceType)
      query = query.where(sql<boolean>`${serviceType}=ANY(${available})`);
    return query
      .select(['c.id', 'c.name'])
      .distinct()
      .orderBy('c.name')
      .orderBy('c.id')
      .execute();
  }
  async findByIds(branchId: string, productId: string) {
    const row = await this.query()
      .select(this.columns())
      .where('bp.branch_id', '=', branchId)
      .where('bp.product_id', '=', productId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Branch product not found');
    return row;
  }
  create(branchId: string, productId: string, types: string[]) {
    return this.change(branchId, productId, { create: true, types });
  }
  updateAvailability(
    branchId: string,
    productId: string,
    isAvailable: boolean,
  ) {
    return this.change(branchId, productId, { isAvailable });
  }
  updateServices(branchId: string, productId: string, types: string[]) {
    return this.change(branchId, productId, { types });
  }
  private async change(
    branchId: string,
    productId: string,
    change: { create?: boolean; types?: string[]; isAvailable?: boolean },
  ) {
    await this.db.transaction().execute(async (tx) => {
      const branch = await tx
        .selectFrom('branches')
        .selectAll()
        .where('id', '=', branchId)
        .forShare()
        .executeTakeFirst();
      if (!branch || branch.status !== 'active')
        throw new NotFoundException('Active branch not found');
      const product = await tx
        .selectFrom('products')
        .selectAll()
        .where('id', '=', productId)
        .forUpdate()
        .executeTakeFirst();
      if (!product) throw new NotFoundException('Product not found');
      const existing = await tx
        .selectFrom('branch_products')
        .selectAll()
        .where('branch_id', '=', branchId)
        .where('product_id', '=', productId)
        .forUpdate()
        .executeTakeFirst();
      if (change.create && existing)
        throw new ConflictException('Product is already on this branch menu');
      if (!change.create && !existing)
        throw new NotFoundException('Branch product not found');
      const types = change.types
        ? services(change.types)
        : existing!.service_types;
      const eligible = product.service_types.filter((t) =>
        t === 'DINE_IN' ? branch.has_dine_in : branch.has_takeaway,
      );
      if (change.create || change.types || change.isAvailable) {
        if (!product.is_active)
          throw new ConflictException(
            'Inactive products cannot be enabled on a menu',
          );
        if (change.types && types.some((t) => !eligible.includes(t)))
          throw new ConflictException(
            'Selected services are not supported by this product and branch',
          );
        if (!types.some((t) => eligible.includes(t)))
          throw new ConflictException(
            'This product has no supported service at the branch',
          );
      }
      if (change.create)
        await tx
          .insertInto('branch_products')
          .values({
            branch_id: branchId,
            product_id: productId,
            price: product.price,
            service_types: types,
            is_available: true,
          })
          .execute();
      else
        await tx
          .updateTable('branch_products')
          .set({
            price: product.price,
            service_types: types,
            is_available: change.isAvailable ?? existing!.is_available,
            updated_at: sql`now()`,
          })
          .where('branch_id', '=', branchId)
          .where('product_id', '=', productId)
          .execute();
      await tx
        .updateTable('products')
        .set({ setup_revision: sql`setup_revision+1`, updated_at: sql`now()` })
        .where('id', '=', productId)
        .execute();
    });
    return this.findByIds(branchId, productId);
  }
}
