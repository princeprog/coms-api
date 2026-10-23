import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDatabase } from '../src/database/create-database';
import {
  down,
  up,
} from '../src/database/migrations/20261023182632_allow_commissary_surplus_deficits';

let db: ReturnType<typeof createDatabase>;
let itemId: string;

beforeAll(async () => {
  const target = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  if (
    !target.startsWith('coms_dispatch_test_') ||
    target !== process.env.COMS_TEST_DATABASE_NAME
  )
    throw new Error('Use scripts/test-disposable-db.cjs');
  db = createDatabase(process.env.DATABASE_URL!);
  itemId = (
    await db
      .insertInto('stock_items')
      .values({
        stock_item_name: `Surplus migration ${randomUUID()}`,
        category: 'Test',
        unit: 'L',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  await db
    .insertInto('commissary_inventory')
    .values({ stock_item_id: itemId, quantity_on_hand: '5' })
    .execute();
});

afterAll(async () => {
  if (!db) return;
  if (itemId) {
    await db
      .deleteFrom('commissary_inventory')
      .where('stock_item_id', '=', itemId)
      .execute();
    await db.deleteFrom('stock_items').where('id', '=', itemId).execute();
  }
  await db.destroy();
});

it('restores the constraint on rollback, preserves balances on reapply and refuses rollback with a deficit', async () => {
  await expect(
    db.transaction().execute(async (tx) => {
      await down(tx);
      await tx
        .updateTable('commissary_inventory')
        .set({ quantity_on_hand: '-5' })
        .where('stock_item_id', '=', itemId)
        .execute();
    }),
  ).rejects.toThrow('commissary_inventory_quantity_nonnegative');

  await db.transaction().execute(async (tx) => {
    await down(tx);
    await up(tx);
  });
  expect(
    (
      await db
        .selectFrom('commissary_inventory')
        .select('quantity_on_hand')
        .where('stock_item_id', '=', itemId)
        .executeTakeFirstOrThrow()
    ).quantity_on_hand,
  ).toBe('5');
  await db
    .updateTable('commissary_inventory')
    .set({ quantity_on_hand: '-5' })
    .where('stock_item_id', '=', itemId)
    .execute();
  await expect(db.transaction().execute(down)).rejects.toThrow(
    'Negative commissary stock exists',
  );
  expect(
    (
      await sql<{
        quantity_on_hand: string;
      }>`SELECT quantity_on_hand::text FROM commissary_inventory WHERE stock_item_id = ${itemId}::uuid`.execute(
        db,
      )
    ).rows[0].quantity_on_hand,
  ).toBe('-5');
});
