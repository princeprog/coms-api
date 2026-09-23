import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { SupplierQueryDto } from './dto/supplier-query.dto';

type SupplierListInput = Pick<
  SupplierQueryDto,
  'page' | 'page_size' | 'search' | 'is_active'
>;
type SupplierCreateInput = {
  supplier_name: string;
  contact_person: string | null;
  contact_number: string | null;
  email: string | null;
  address: string | null;
};
type SupplierUpdateInput = Partial<SupplierCreateInput>;

@Injectable()
export class SuppliersRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async list(input: SupplierListInput) {
    let records = this.db
      .selectFrom('suppliers')
      .selectAll()
      .orderBy('supplier_name')
      .orderBy('id')
      .limit(input.page_size)
      .offset((input.page - 1) * input.page_size);
    let count = this.db
      .selectFrom('suppliers')
      .select((eb) => eb.fn.countAll<number>().as('total'));

    if (input.search) {
      const escapedSearch = input.search.replace(/[\\%_]/g, '\\$&');
      const pattern = `%${escapedSearch}%`;
      records = records.where('supplier_name', 'ilike', pattern);
      count = count.where('supplier_name', 'ilike', pattern);
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
      .selectFrom('suppliers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  create(input: SupplierCreateInput) {
    return this.db
      .insertInto('suppliers')
      .values(input)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(id: string, patch: SupplierUpdateInput) {
    const supplier = await this.db
      .updateTable('suppliers')
      .set({ ...patch, updated_at: sql<Date>`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  async deactivate(id: string) {
    const supplier = await this.db
      .updateTable('suppliers')
      .set({ is_active: false, updated_at: sql<Date>`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }
}
