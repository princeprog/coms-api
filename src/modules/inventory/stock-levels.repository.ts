import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import { recordAudit } from '../audit/audit-recorder';

type Levels = { reorderLevel: string; targetLevel: string };

type SetLevelsInput = {
  stockItemId: string;
  /** null for the commissary. */
  branchIds: string[] | null;
  /** null clears the levels. */
  levels: Levels | null;
  actorUserId: string;
};

type Location = { branchId: string | null; label: string };

@Injectable()
export class StockLevelsRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async set(input: SetLevelsInput) {
    try {
      return await this.db.transaction().execute(async (tx) => {
        const stock = await tx
          .selectFrom('stock_items')
          .select(['id', 'stock_item_name', 'is_active'])
          .where('id', '=', input.stockItemId)
          .forShare()
          .executeTakeFirst();
        if (!stock?.is_active)
          throw new NotFoundException('Active stock item not found');

        let locations: Location[] = [{ branchId: null, label: 'Commissary' }];
        if (input.branchIds) {
          const branches = await tx
            .selectFrom('branches')
            .select(['id', 'branch_name'])
            .where('id', 'in', input.branchIds)
            .where('status', '=', 'active')
            .forShare()
            .execute();
          if (branches.length !== input.branchIds.length)
            throw new NotFoundException('Active branch not found');
          locations = branches.map((branch) => ({
            branchId: branch.id,
            label: branch.branch_name,
          }));
        }

        let changed = 0;
        for (const location of locations) {
          const previous = await tx
            .selectFrom('stock_levels')
            .select([
              'id',
              sql<string>`trim_scale(reorder_level)::text`.as('reorder_level'),
              sql<string>`trim_scale(target_level)::text`.as('target_level'),
            ])
            .where('stock_item_id', '=', stock.id)
            .where(
              'inventory_scope',
              '=',
              location.branchId ? 'BRANCH' : 'COMMISSARY',
            )
            .$call((query) =>
              location.branchId
                ? query.where('branch_id', '=', location.branchId)
                : query.where('branch_id', 'is', null),
            )
            .forUpdate()
            .executeTakeFirst();
          const next = input.levels;
          if (!previous && !next) continue;
          if (
            previous &&
            next &&
            previous.reorder_level === next.reorderLevel &&
            previous.target_level === next.targetLevel
          )
            continue;

          if (!next && previous)
            await tx
              .deleteFrom('stock_levels')
              .where('id', '=', previous.id)
              .execute();
          else if (next && previous)
            await tx
              .updateTable('stock_levels')
              .set({
                reorder_level: next.reorderLevel,
                target_level: next.targetLevel,
                updated_by_user_id: input.actorUserId,
                updated_at: sql<Date>`now()`,
              })
              .where('id', '=', previous.id)
              .execute();
          else if (next)
            await tx
              .insertInto('stock_levels')
              .values({
                inventory_scope: location.branchId ? 'BRANCH' : 'COMMISSARY',
                branch_id: location.branchId,
                stock_item_id: stock.id,
                reorder_level: next.reorderLevel,
                target_level: next.targetLevel,
                updated_by_user_id: input.actorUserId,
              })
              .execute();

          await recordAudit(tx, {
            actorUserId: input.actorUserId,
            action: next
              ? 'stock_item.levels_set'
              : 'stock_item.levels_cleared',
            entityType: 'stock_item',
            entityId: stock.id,
            entityLabel: stock.stock_item_name,
            branchId: location.branchId,
            changes: {
              reorder_level: {
                from: previous?.reorder_level ?? null,
                to: next?.reorderLevel ?? null,
              },
              target_level: {
                from: previous?.target_level ?? null,
                to: next?.targetLevel ?? null,
              },
            },
            metadata: { location: location.label },
          });
          changed += 1;
        }

        return {
          stock_item_id: stock.id,
          reorder_level: input.levels?.reorderLevel ?? null,
          target_level: input.levels?.targetLevel ?? null,
          locations: locations.length,
          changed,
        };
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      )
        throw new ConflictException(
          'These levels were changed at the same time. Try again.',
        );
      throw error;
    }
  }
}
