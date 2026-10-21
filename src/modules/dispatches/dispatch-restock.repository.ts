import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import { onTheWaySql } from '../inventory/stock-position';

export type RestockSuggestionRow = {
  stock_item_id: string;
  stock_item_name: string;
  unit: string;
  on_hand: string;
  on_the_way: string;
  reorder_level: string;
  target_level: string;
  suggested_quantity: string;
  quantity_to_send: string;
  commissary_available: string;
};

@Injectable()
export class DispatchRestockRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async isActiveBranch(branchId: string) {
    const branch = await this.db
      .selectFrom('branches')
      .select('id')
      .where('id', '=', branchId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return Boolean(branch);
  }

  /**
   * Active items at or below their reorder level at the branch, counting
   * stock on the way. Suggests enough to reach the target, capped at what the
   * commissary holds. Below-zero items first, then the emptiest.
   */
  async suggestions(branchId: string) {
    const result = await sql<RestockSuggestionRow>`
      WITH lines AS (
        SELECT si.id AS stock_item_id, si.stock_item_name, si.unit,
          coalesce(bi.quantity_on_hand, 0) AS on_hand,
          ${onTheWaySql(sql`${branchId}::uuid`, sql.ref('si.id'))} AS on_the_way,
          sl.reorder_level, sl.target_level,
          coalesce(ci.quantity_on_hand, 0) AS available
        FROM stock_levels sl
        JOIN stock_items si ON si.id = sl.stock_item_id AND si.is_active
        LEFT JOIN branch_inventory bi
          ON bi.branch_id = sl.branch_id AND bi.stock_item_id = si.id
        LEFT JOIN commissary_inventory ci ON ci.stock_item_id = si.id
        WHERE sl.inventory_scope = 'BRANCH' AND sl.branch_id = ${branchId}::uuid
      )
      SELECT stock_item_id, stock_item_name, unit,
        trim_scale(on_hand)::text AS on_hand,
        trim_scale(on_the_way)::text AS on_the_way,
        trim_scale(reorder_level)::text AS reorder_level,
        trim_scale(target_level)::text AS target_level,
        trim_scale(target_level - on_hand - on_the_way)::text AS suggested_quantity,
        trim_scale(greatest(least(target_level - on_hand - on_the_way, available), 0))::text
          AS quantity_to_send,
        trim_scale(available)::text AS commissary_available
      FROM lines
      WHERE on_hand + on_the_way <= reorder_level
      ORDER BY (on_hand < 0) DESC, on_hand / target_level, stock_item_name
    `.execute(this.db);
    return result.rows;
  }
}
