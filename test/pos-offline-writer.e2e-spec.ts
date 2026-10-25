import '../src/config/load-env';
import { ConflictException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE, DatabaseModule } from '../src/database/database.module';
import type { DB, Json } from '../src/database/db';
import {
  postOfflineSale,
  type OfflineEnvelope,
  type OfflineSnapshot,
} from '../src/modules/pos-offline/offline-sale-writer';
import { SalesRepository } from '../src/modules/sales/sales.repository';
import { testProductCategoryId } from './product-category-fixture';
import { openTestShift } from './shift-fixture';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('offline snapshot writer (disposable PostgreSQL)', () => {
  let module: TestingModule;
  let db: Kysely<DB>;
  let sales: SalesRepository;
  let cashier: string, cash: string, nonCash: string;
  let branch: string, shift: string, product: string, stock: string;
  let snapshot: OfflineSnapshot, envelope: OfflineEnvelope;
  const session = () => ({
    branch_id: branch,
    cashier_id: cashier,
    shift_id: shift,
  });
  const write = (payload = envelope, saved = snapshot) =>
    db
      .transaction()
      .execute((tx) => postOfflineSale(tx, session(), saved, payload));
  const ordinary = (paymentMethodId: string, registerDeviceId?: string) => ({
    branchId: branch,
    actorUserId: cashier,
    paymentMethodId,
    registerDeviceId,
    tenderMethod: paymentMethodId === cash ? 'Cash' : 'Card',
    serviceType: 'DINE_IN' as const,
    idempotencyKey: randomUUID(),
    items: [{ productId: product, quantity: '3', priceRevision: 1 }],
  });

  beforeAll(async () => {
    if (!process.env.COMS_TEST_DATABASE_NAME?.startsWith('coms_dispatch_test_'))
      throw new Error('Run through scripts/test-disposable-db.cjs');
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [SalesRepository],
    }).compile();
    db = module.get(DATABASE);
    sales = module.get(SalesRepository);
    cashier = (
      await db
        .insertInto('coms_auth.users')
        .values({
          email: `writer-${randomUUID()}@example.invalid`,
          full_name: 'Writer cashier',
          contact_number: randomUUID().slice(0, 20),
          hashed_password: 'unused',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    cash = (
      await db
        .insertInto('payment_methods')
        .values({
          name: `Writer cash ${randomUUID().slice(0, 8)}`,
          kind: 'CASH',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    nonCash = (
      await db
        .insertInto('payment_methods')
        .values({
          name: `Writer card ${randomUUID().slice(0, 8)}`,
          kind: 'NON_CASH',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });
  afterAll(async () => {
    await module?.close();
  });

  beforeEach(async () => {
    branch = (
      await db
        .insertInto('branches')
        .values({
          code: `W-${randomUUID().slice(0, 8)}`,
          branch_name: 'Writer branch',
          has_dine_in: true,
          has_takeaway: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    shift = await openTestShift(db, branch, cashier);
    stock = (
      await db
        .insertInto('stock_items')
        .values({
          stock_item_name: `Writer rice ${randomUUID()}`,
          category: 'Ingredient',
          unit: 'kg',
          usage_types: ['INGREDIENT'],
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const createdProduct = await db
      .insertInto('products')
      .values({
        product_name: `Saved rice meal ${randomUUID()}`,
        price: '0.1',
        price_revision: 1,
        category_id: testProductCategoryId,
        service_types: ['DINE_IN', 'TAKEAWAY'],
      })
      .returning(['id', 'category_id', 'product_name'])
      .executeTakeFirstOrThrow();
    product = createdProduct.id;
    await db
      .insertInto('branch_products')
      .values({
        branch_id: branch,
        product_id: product,
        price: '0.1',
        service_types: ['DINE_IN', 'TAKEAWAY'],
      })
      .execute();
    await db
      .insertInto('product_ingredients')
      .values({
        product_id: product,
        stock_item_id: stock,
        quantity_required: '0.25',
        usage_scope: 'ALL',
      })
      .execute();
    await db
      .insertInto('stock_item_costs')
      .values({
        stock_item_id: stock,
        average_unit_cost: '7.125',
        cost_source: 'MANUAL',
      })
      .execute();
    snapshot = {
      branch: {
        id: branch,
        name: 'Saved branch',
        supports_dine_in: true,
        supports_takeaway: true,
      },
      cash_payment_method: { id: cash, name: 'Saved cash' },
      products: [
        {
          id: product,
          name: createdProduct.product_name,
          category_id: createdProduct.category_id,
          category_name: 'Rice meals',
          price: '0.1',
          price_revision: 1,
          supports_dine_in: true,
          supports_takeaway: true,
          recipe: [
            {
              stock_item_id: stock,
              quantity_required: '0.25',
              usage_scope: 'ALL',
              unit_cost: '7.125',
            },
          ],
        },
      ],
    };
    envelope = {
      id: randomUUID(),
      session_id: randomUUID(),
      device_id: randomUUID(),
      shift_id: shift,
      sequence: 1,
      snapshot_id: randomUUID(),
      captured_at: new Date(Date.now() - 60_000).toISOString(),
      service_type: 'DINE_IN',
      items: [
        {
          product_id: product,
          quantity: '3',
          unit_price: '0.10',
          price_revision: 1,
        },
      ],
      cash_tendered: '0.30',
      total_amount: '0.3',
    };
  });

  async function reserve(tx: Kysely<DB> | Transaction<DB> = db) {
    await tx
      .insertInto('pos_offline_devices')
      .values({
        id: envelope.device_id,
        branch_id: branch,
        name: 'Writer register',
        status: 'APPROVED',
        requested_by: cashier,
        approved_by: cashier,
      })
      .execute();
    await tx
      .insertInto('pos_offline_sessions')
      .values({
        id: envelope.session_id,
        branch_id: branch,
        shift_id: shift,
        cashier_id: cashier,
        device_id: envelope.device_id,
        business_date: sql<Date>`coms_business_date(now())`,
        cutoff_at: sql<Date>`now() + interval '1 hour'`,
      })
      .execute();
  }

  async function artifacts() {
    const result = await sql<{
      sales: string;
      items: string;
      consumptions: string;
      movements: string;
      events: string;
      balances: string;
    }>`
      SELECT (SELECT count(*)::text FROM sales WHERE branch_id = ${branch}) AS sales,
        (SELECT count(*)::text FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.branch_id = ${branch}) AS items,
        (SELECT count(*)::text FROM sale_item_consumptions c JOIN sale_items i ON i.id = c.sale_item_id JOIN sales s ON s.id = i.sale_id WHERE s.branch_id = ${branch}) AS consumptions,
        (SELECT count(*)::text FROM inventory_movements WHERE branch_id = ${branch}) AS movements,
        (SELECT count(*)::text FROM sale_events e JOIN sales s ON s.id = e.sale_id WHERE s.branch_id = ${branch}) AS events,
        (SELECT count(*)::text FROM branch_inventory WHERE branch_id = ${branch}) AS balances
    `.execute(db);
    return result.rows[0];
  }

  it('computes 0.1 × 3 exactly, deducts below zero, and dates every posted fact at capture', async () => {
    const result = await write();
    expect(result.sale_reference).toMatch(/^S-\d{6,}$/);
    const sale = await db
      .selectFrom('sales')
      .selectAll()
      .where('id', '=', result.id)
      .executeTakeFirstOrThrow();
    expect(sale.total_amount).toBe('0.3');
    expect(sale.occurred_at.toISOString()).toBe(envelope.captured_at);
    expect(sale.created_at.getTime()).toBeGreaterThan(
      sale.occurred_at.getTime(),
    );
    expect(sale.payment_kind).toBe('CASH');
    expect(sale.tender_method).toBe('Saved cash');
    const item = await db
      .selectFrom('sale_items')
      .selectAll()
      .where('sale_id', '=', sale.id)
      .executeTakeFirstOrThrow();
    expect(item.line_total).toBe('0.3');
    const consumption = await db
      .selectFrom('sale_item_consumptions')
      .selectAll()
      .where('sale_item_id', '=', item.id)
      .executeTakeFirstOrThrow();
    expect(consumption.quantity_consumed).toBe('0.75');
    expect(consumption.unit_cost).toBe('7.125');
    const movement = await db
      .selectFrom('inventory_movements')
      .selectAll()
      .where('sale_item_consumption_id', '=', consumption.id)
      .executeTakeFirstOrThrow();
    expect(movement.quantity_delta).toBe('-0.75');
    expect(movement.occurred_at.toISOString()).toBe(envelope.captured_at);
    const balance = await db
      .selectFrom('branch_inventory')
      .select('quantity_on_hand')
      .where('branch_id', '=', branch)
      .where('stock_item_id', '=', stock)
      .executeTakeFirstOrThrow();
    expect(balance.quantity_on_hand).toBe('-0.75');
    const event = await db
      .selectFrom('sale_events')
      .selectAll()
      .where('sale_id', '=', sale.id)
      .executeTakeFirstOrThrow();
    expect(event.occurred_at.toISOString()).toBe(envelope.captured_at);
  });

  it.each([
    ['tiny total difference', { total_amount: '0.30000000000000000001' }],
    ['under tender', { cash_tendered: '0.29999999999999999999' }],
    [
      'changed price',
      {
        items: [
          {
            quantity: '3',
            unit_price: '0.10000000000000000001',
            price_revision: 1,
          },
        ],
      },
    ],
    [
      'changed revision',
      { items: [{ quantity: '3', unit_price: '0.1', price_revision: 2 }] },
    ],
    [
      'zero quantity',
      { items: [{ quantity: '0', unit_price: '0.1', price_revision: 1 }] },
    ],
    [
      'negative quantity',
      { items: [{ quantity: '-3', unit_price: '0.1', price_revision: 1 }] },
    ],
    [
      'changed quantity',
      {
        items: [
          {
            quantity: '3.00000000000000000001',
            unit_price: '0.1',
            price_revision: 1,
          },
        ],
      },
    ],
  ])(
    'holds %s and leaves no sale, cost or inventory artifacts',
    async (_label, patch) => {
      const payload: OfflineEnvelope = {
        ...envelope,
        ...patch,
        items:
          'items' in patch
            ? patch.items.map((item) => ({ ...item, product_id: product }))
            : envelope.items,
      };
      await expect(write(payload)).rejects.toBeInstanceOf(ConflictException);
      expect(await artifacts()).toEqual({
        sales: '0',
        items: '0',
        consumptions: '0',
        movements: '0',
        events: '0',
        balances: '0',
      });
    },
  );

  it('preserves a value above Number safe integer range exactly', async () => {
    snapshot.products[0].price = '9007199254740993.01';
    envelope.items[0].unit_price = '9007199254740993.01';
    envelope.items[0].quantity = '0.1';
    envelope.total_amount = '900719925474099.301';
    envelope.cash_tendered = '900719925474099.301';
    const result = await write();
    const sale = await db
      .selectFrom('sales')
      .select('total_amount')
      .where('id', '=', result.id)
      .executeTakeFirstOrThrow();
    expect(sale.total_amount).toBe('900719925474099.301');
  });

  it('uses persisted immutable recipes, prices, names, eligibility and costs after live changes', async () => {
    snapshot.products[0].recipe.push(
      {
        stock_item_id: stock,
        quantity_required: '0.125',
        usage_scope: 'DINE_IN',
        unit_cost: '7.125',
      },
      {
        stock_item_id: stock,
        quantity_required: '1000',
        usage_scope: 'TAKEAWAY',
        unit_cost: '7.125',
      },
    );
    await reserve();
    await db
      .insertInto('pos_offline_snapshots')
      .values({
        id: envelope.snapshot_id,
        session_id: envelope.session_id,
        payload: JSON.stringify(snapshot) as unknown as Json,
      })
      .execute();
    await db
      .updateTable('products')
      .set({
        product_name: 'Changed live meal',
        price: '50',
        price_revision: 2,
        is_active: false,
        service_types: ['TAKEAWAY'],
      })
      .where('id', '=', product)
      .execute();
    await db
      .deleteFrom('product_ingredients')
      .where('product_id', '=', product)
      .execute();
    await db
      .updateTable('stock_item_costs')
      .set({ average_unit_cost: '999' })
      .where('stock_item_id', '=', stock)
      .execute();
    await db
      .updateTable('branch_products')
      .set({ is_available: false })
      .where('branch_id', '=', branch)
      .where('product_id', '=', product)
      .execute();
    const saved = await db
      .selectFrom('pos_offline_snapshots')
      .select('payload')
      .where('id', '=', envelope.snapshot_id)
      .executeTakeFirstOrThrow();
    const result = await write(
      envelope,
      saved.payload as unknown as OfflineSnapshot,
    );
    const item = await db
      .selectFrom('sale_items')
      .selectAll()
      .where('sale_id', '=', result.id)
      .executeTakeFirstOrThrow();
    expect(item.product_name_snapshot).toBe(snapshot.products[0].name);
    expect(item.unit_price).toBe('0.1');
    const consumption = await db
      .selectFrom('sale_item_consumptions')
      .selectAll()
      .where('sale_item_id', '=', item.id)
      .executeTakeFirstOrThrow();
    expect(consumption.quantity_consumed).toBe('1.125');
    expect(consumption.unit_cost).toBe('7.125');
    await expect(
      db
        .updateTable('pos_offline_snapshots')
        .set({ payload: '{}' })
        .where('id', '=', envelope.snapshot_id)
        .execute(),
    ).rejects.toThrow('immutable');
  });

  it('preserves a missing snapshot cost even when a live cost exists', async () => {
    snapshot.products[0].recipe[0].unit_cost = null;
    const result = await write();
    const cost = await db
      .selectFrom('sale_item_consumptions as c')
      .innerJoin('sale_items as i', 'i.id', 'c.sale_item_id')
      .select('c.unit_cost')
      .where('i.sale_id', '=', result.id)
      .executeTakeFirstOrThrow();
    expect(cost.unit_cost).toBeNull();
  });

  it('rolls back sale, items, costs, movements, event and new balance when caller aborts', async () => {
    const failure = new Error('caller abort after complete write');
    await expect(
      db.transaction().execute(async (tx) => {
        await postOfflineSale(tx, session(), snapshot, envelope);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await artifacts()).toEqual({
      sales: '0',
      items: '0',
      consumptions: '0',
      movements: '0',
      events: '0',
      balances: '0',
    });
  });

  it('blocks all ordinary cash and other-device non-cash but accepts reserved-device non-cash', async () => {
    await reserve();
    for (const method of [cash, nonCash]) {
      for (const device of [undefined, randomUUID()]) {
        await expect(
          sales.create(ordinary(method, device)),
        ).rejects.toBeInstanceOf(ConflictException);
      }
    }
    await expect(
      sales.create(ordinary(cash, envelope.device_id)),
    ).rejects.toBeInstanceOf(ConflictException);
    const result = await sales.create(ordinary(nonCash, envelope.device_id));
    expect(result.payment_kind).toBe('NON_CASH');
    expect(result.total_amount).toBe('0.3');
    expect((await artifacts()).sales).toBe('1');
  });

  it('preserves ordinary cash and non-cash checkout without a reservation', async () => {
    expect((await sales.create(ordinary(cash))).payment_kind).toBe('CASH');
    expect((await sales.create(ordinary(nonCash))).payment_kind).toBe(
      'NON_CASH',
    );
  });

  it('waits for an in-flight reservation and rejects ordinary cash after its commit', async () => {
    const ready = deferred<number>();
    const release = deferred<void>();
    const reservation = db.transaction().execute(async (tx) => {
      await tx
        .selectFrom('branches')
        .select('id')
        .where('id', '=', branch)
        .forShare()
        .execute();
      await tx
        .selectFrom('register_shifts')
        .select('id')
        .where('id', '=', shift)
        .forUpdate()
        .execute();
      await reserve(tx);
      const pid = await sql<{
        pid: number;
      }>`SELECT pg_backend_pid() AS pid`.execute(tx);
      ready.resolve(pid.rows[0].pid);
      await release.promise;
    });
    reservation.catch((error) => ready.reject(error));
    const pid = await ready.promise;
    const attempt = sales.create(ordinary(cash)).then(
      (value) => ({ value, error: undefined }),
      (error) => ({ value: undefined, error: error as unknown }),
    );
    try {
      await expect
        .poll(
          async () => {
            const blocked = await sql<{
              count: number;
            }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`.execute(
              db,
            );
            return blocked.rows[0].count;
          },
          { timeout: 5000 },
        )
        .toBeGreaterThan(0);
    } finally {
      release.resolve();
      await reservation;
    }
    const outcome = await attempt;
    expect(outcome.error).toBeInstanceOf(ConflictException);
    expect((await artifacts()).sales).toBe('0');
  }, 15000);
});
