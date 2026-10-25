import { ConflictException } from '@nestjs/common';
import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import type { Pool } from 'pg';
import type { DB } from '../../database/db';
import {
  postOfflineSale,
  type OfflineEnvelope,
  type OfflineSnapshot,
} from './offline-sale-writer';
import { requireOrdinarySaleReservation } from '../sales/sales.repository';

vi.mock('../../database/database.module', () => ({
  DATABASE: Symbol('DATABASE'),
}));

const productId = '00000000-0000-4000-8000-000000000001';
const session = {
  branch_id: 'branch',
  cashier_id: 'cashier',
  shift_id: 'shift',
};
const snapshot: OfflineSnapshot = {
  branch: {
    id: 'branch',
    name: 'Branch',
    supports_dine_in: true,
    supports_takeaway: true,
  },
  cash_payment_method: { id: 'cash', name: 'Cash snapshot' },
  products: [
    {
      id: productId,
      name: 'Saved product',
      category_id: 'category',
      category_name: 'Category',
      price: '0.1',
      price_revision: 2,
      supports_dine_in: true,
      supports_takeaway: false,
      recipe: [],
    },
  ],
};
const envelope: OfflineEnvelope = {
  id: '00000000-0000-4000-8000-000000000002',
  session_id: 'session',
  device_id: 'device',
  shift_id: 'shift',
  sequence: 1,
  snapshot_id: 'snapshot',
  captured_at: '2026-10-26T02:00:00.000Z',
  service_type: 'DINE_IN',
  items: [
    {
      product_id: productId,
      quantity: '3',
      unit_price: '0.10',
      price_revision: 2,
    },
  ],
  cash_tendered: '0.3',
  total_amount: '0.30',
};

// Exercise actual Kysely query compilation; only the external PG connection is fake.
function executor(responses: (Record<string, unknown>[] | Error)[] = []) {
  const queries: { sql: string; parameters: readonly unknown[] }[] = [];
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: {
        connect: async () => ({
          query: async (sql: string, parameters: readonly unknown[]) => {
            queries.push({ sql, parameters });
            const rows = responses.shift();
            if (!rows) throw new Error(`Unexpected query: ${sql}`);
            if (rows instanceof Error) throw rows;
            return { rows, rowCount: rows.length, command: 'SELECT' };
          },
          release() {},
        }),
        end: async () => {},
      } as unknown as Pool,
    }),
  });
  return { tx: db as unknown as Transaction<DB>, queries };
}

describe('offline snapshot sale writer', () => {
  it.each([
    ['zero quantity', { items: [{ ...envelope.items[0], quantity: '0' }] }],
    [
      'negative quantity',
      { items: [{ ...envelope.items[0], quantity: '-1' }] },
    ],
    ['non decimal', { total_amount: 'NaN' }],
    ['numeric instead of decimal text', { cash_tendered: 0.3 }],
    ['repeated product', { items: [envelope.items[0], envelope.items[0]] }],
    [
      'missing product',
      { items: [{ ...envelope.items[0], product_id: 'missing' }] },
    ],
    [
      'changed revision',
      { items: [{ ...envelope.items[0], price_revision: 3 }] },
    ],
    ['unsupported service', { service_type: 'TAKEAWAY' }],
    ['wrong shift', { shift_id: 'other' }],
    ['timestamp without offset', { captured_at: '2026-10-26T02:00:00' }],
    ['empty cart', { items: [] }],
    ['null item', { items: [null] }],
  ])('holds %s before writing', async (_label, patch) => {
    const { tx, queries } = executor();
    await expect(
      postOfflineSale(tx, session, snapshot, {
        ...envelope,
        ...patch,
      } as OfflineEnvelope),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(queries).toHaveLength(0);
  });

  it('holds a SQL numeric validation mismatch without writing a sale', async () => {
    const { tx, queries } = executor([[{ valid: false }]]);
    await expect(
      postOfflineSale(tx, session, snapshot, envelope),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('numeric');
    expect(queries[0].sql).not.toMatch(/INSERT/i);
  });

  it('persists exact snapshot values and occurrence time using only the caller executor', async () => {
    const { tx, queries } = executor([
      [{ valid: true }],
      [{ product_id: productId, line_total: '0.3' }],
      [{ id: 'sale', sale_number: '42' }],
      [{ id: 'item', product_id: productId }],
      [],
    ]);
    await expect(
      postOfflineSale(tx, session, snapshot, envelope),
    ).resolves.toEqual({ id: 'sale', sale_reference: 'S-000042' });
    const sale = queries.find((q) => /insert into "?sales"?/i.test(q.sql))!;
    expect(sale.parameters).toEqual(
      expect.arrayContaining([
        '0.30',
        'Cash snapshot',
        envelope.captured_at,
        'CASH',
      ]),
    );
    const item = queries.find((q) => /insert into "sale_items"/i.test(q.sql))!;
    expect(item.parameters).toEqual(
      expect.arrayContaining(['Saved product', '0.1', '3', '0.3']),
    );
    expect(queries.at(-1)!.parameters).toContain(envelope.captured_at);
    expect(queries.map((q) => q.sql).join('\n')).not.toMatch(
      /(?:FROM|JOIN)\s+"?(?:products|product_ingredients|stock_item_costs|payment_methods)\b/i,
    );
  });

  it('passes decimals beyond floating-point precision unchanged to SQL validation', async () => {
    const { tx, queries } = executor([[{ valid: false }]]);
    await expect(
      postOfflineSale(tx, session, snapshot, {
        ...envelope,
        cash_tendered: '9007199254740993.01',
        total_amount: '0.30000000000000000001',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(queries[0].parameters).toEqual(
      expect.arrayContaining([
        '9007199254740993.01',
        '0.30000000000000000001',
        '0.10',
        '0.1',
        '3',
      ]),
    );
    expect(queries[0].sql).toMatch(/unit_price = saved_price/);
    expect(queries[0].sql).toMatch(
      /sum\(quantity \* saved_price\) = \$\d+::numeric/,
    );
    expect(queries[0].sql).toMatch(/\$\d+::numeric >= \$\d+::numeric/);
  });

  it.each(['7.125', null])(
    'writes saved recipe cost %s, scoped consumption and a negative movement at capture time',
    async (cost) => {
      const stock = '00000000-0000-4000-8000-000000000003';
      const offlineSnapshot: OfflineSnapshot = {
        ...snapshot,
        products: [
          {
            ...snapshot.products[0],
            recipe: [
              {
                stock_item_id: stock,
                quantity_required: '0.25',
                usage_scope: 'ALL',
                unit_cost: cost,
              },
              {
                stock_item_id: stock,
                quantity_required: '0.125',
                usage_scope: 'DINE_IN',
                unit_cost: cost,
              },
              {
                stock_item_id: 'takeout-stock',
                quantity_required: '999',
                usage_scope: 'TAKEAWAY',
                unit_cost: '999',
              },
            ],
          },
        ],
      };
      const { tx, queries } = executor([
        [{ valid: true }],
        [{ product_id: productId, line_total: '0.3' }],
        [
          {
            product_id: productId,
            stock_item_id: stock,
            quantity_consumed: '1.125',
            unit_cost: cost,
          },
        ],
        [{ id: 'sale', sale_number: '43' }],
        [{ id: 'item', product_id: productId }],
        [
          {
            id: 'consumption',
            stock_item_id: stock,
            quantity_consumed: '1.125',
          },
        ],
        [{ stock_item_id: stock, quantity: '1.125' }],
        [],
        [{ stock_item_id: stock }],
        [],
        [],
        [],
      ]);
      await expect(
        postOfflineSale(tx, session, offlineSnapshot, envelope),
      ).resolves.toEqual({ id: 'sale', sale_reference: 'S-000043' });
      const recipe = queries[2];
      expect(recipe.parameters).toEqual(
        expect.arrayContaining(['0.25', '0.125', '3']),
      );
      expect(recipe.parameters).not.toContain('takeout-stock');
      const consumption = queries.find((q) =>
        /insert into "sale_item_consumptions"/.test(q.sql),
      )!;
      expect(consumption.parameters).toContain(cost);
      const movement = queries.find((q) =>
        /insert into "inventory_movements"/.test(q.sql),
      )!;
      expect(movement.parameters).toEqual(
        expect.arrayContaining(['-1.125', envelope.captured_at, 'consumption']),
      );
      const balance = queries.find((q) =>
        /update "branch_inventory"/.test(q.sql),
      )!;
      expect(balance.sql).toMatch(/quantity_on_hand - \$\d+::numeric/);
      expect(balance.sql).not.toMatch(/quantity_on_hand\s*>=/);
      expect(queries.map((q) => q.sql).join('\n')).not.toMatch(
        /(?:FROM|JOIN)\s+"?(?:products|product_ingredients|stock_item_costs|payment_methods)\b/i,
      );
    },
  );

  it('propagates a database failure so the caller can roll back the complete sale', async () => {
    const failure = new Error('event insert failed');
    const { tx } = executor([
      [{ valid: true }],
      [{ product_id: productId, line_total: '0.3' }],
      [{ id: 'sale', sale_number: '42' }],
      [{ id: 'item', product_id: productId }],
      failure,
    ]);
    await expect(postOfflineSale(tx, session, snapshot, envelope)).rejects.toBe(
      failure,
    );
  });
});

describe('ordinary sale register reservation', () => {
  it.each([
    ['CASH', 'reserved', false],
    ['CASH', undefined, false],
    ['NON_CASH', undefined, false],
    ['NON_CASH', 'other', false],
    ['NON_CASH', 'reserved', true],
  ])('%s from device %s allowed=%s', async (kind, device, allowed) => {
    const { tx } = executor([[{ device_id: 'reserved' }]]);
    const result = requireOrdinarySaleReservation(tx, 'branch', kind, device);
    if (allowed) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toBeInstanceOf(ConflictException);
  });

  it.each(['CASH', 'NON_CASH'])(
    'preserves %s without a reservation',
    async (kind) => {
      const { tx } = executor([[]]);
      await expect(
        requireOrdinarySaleReservation(tx, 'branch', kind),
      ).resolves.toBeUndefined();
    },
  );
});
