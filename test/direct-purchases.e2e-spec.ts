import '../src/config/load-env';
import {
  ExecutionContext,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import request from 'supertest';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { down as removePurchaseSchema } from '../src/database/migrations/20261020221155_direct_purchase_receipts';
import { AppModule } from '../src/app.module';
import { DATABASE } from '../src/database/database.module';
import { AuthGuard } from '../src/common/guards/auth.guard';
import { AuthGatewayGuard } from '../src/common/guards/auth-gateway.guard';
import { AccessControlService } from '../src/modules/access-control/access-control.service';

describe('direct purchases (disposable DB only)', () => {
  let app: INestApplication;
  let db: Kysely<any>;
  let actor: string;
  let item: string;
  let permissions = [
    'supplier_receipts.create',
    'supplier_receipts.read',
    'inventory.commissary_read',
  ];
  const body = () => ({
    purchase_date: '2026-10-01',
    store_name: 'Puregold',
    receipt_number: 'PG-123',
    notes: 'Grocery restock',
    items: [
      { stock_item_id: item, quantity_received: '2.50', unit_cost: '13.25' },
    ],
  });
  const post = (data = body(), key = randomUUID()) =>
    request(app.getHttpServer())
      .post('/direct-purchases')
      .set('Idempotency-Key', key)
      .send(data);
  beforeAll(async () => {
    if (!process.env.COMS_TEST_DATABASE_NAME?.startsWith('coms_dispatch_test_'))
      throw new Error('Run using scripts/test-disposable-db.cjs');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(AuthGatewayGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = { id: actor };
          return true;
        },
      })
      .overrideProvider(AccessControlService)
      .useValue({
        findAccessContext: async () => ({
          userId: actor,
          accountActive: true,
          role: {
            id: 'test',
            code: 'RECEIVER',
            name: 'Receiver',
            isActive: true,
            isSystem: false,
          },
          permissions,
          branchIds: [],
        }),
      })
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    db = app.get(DATABASE);
    actor = (
      await db.selectFrom('auth.users').select('id').executeTakeFirstOrThrow()
    ).id;
    item = (
      await db
        .insertInto('stock_items')
        .values({
          stock_item_name: 'Grocery flour',
          category: 'Dry goods',
          unit: 'kg',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });
  afterAll(async () => {
    await app?.close();
  });
  it('records without a supplier, calculates exact cost and posts once under concurrent retries', async () => {
    const key = randomUUID();
    const [a, b] = await Promise.all([post(body(), key), post(body(), key)]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).toBe(b.body.id);
    expect(a.body.total_cost).toBe('33.125');
    expect(a.body.supplier_id).toBeNull();
    expect(
      (
        await db
          .selectFrom('commissary_inventory')
          .select('quantity_on_hand')
          .where('stock_item_id', '=', item)
          .executeTakeFirstOrThrow()
      ).quantity_on_hand,
    ).toBe('2.5');
    expect(
      (
        await db
          .selectFrom('inventory_movements')
          .selectAll()
          .where('stock_item_id', '=', item)
          .execute()
      ).length,
    ).toBe(1);
    expect(
      (
        await request(app.getHttpServer()).get(
          '/supplier-receipts/' + a.body.id,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app.getHttpServer()).get('/supplier-receipts')
      ).body.items.some((r: { id: string }) => r.id === a.body.id),
    ).toBe(false);
    expect(
      (await post({ ...body(), store_name: 'Another store' }, key)).status,
    ).toBe(409);
    const movement = await request(app.getHttpServer()).get(
      '/inventory/commissary/movements',
    );
    expect(
      movement.body.items.find(
        (r: { stock_item_id: string }) => r.stock_item_id === item,
      ),
    ).toMatchObject({ receipt_kind: 'DIRECT_PURCHASE', receipt_id: a.body.id });
  });
  it('validates dates, missing costs, duplicate/inactive items and disallows branch destinations', async () => {
    for (const patch of [
      { purchase_date: '2099-01-01' },
      { purchase_date: '2026-02-30' },
      { items: [{ stock_item_id: item, quantity_received: '1' }] },
      { items: [...body().items, ...body().items] },
      { branch_id: randomUUID() },
      { items: [{ ...body().items[0], quantity_received: '0' }] },
    ])
      expect(
        (await post({ ...body(), ...patch } as ReturnType<typeof body>)).status,
      ).toBe(400);
    const before = await db
      .selectFrom('commissary_inventory')
      .selectAll()
      .where('stock_item_id', '=', item)
      .executeTakeFirst();
    expect(
      (
        await post({
          ...body(),
          items: [
            ...body().items,
            {
              stock_item_id: randomUUID(),
              quantity_received: '1',
              unit_cost: '1',
            },
          ],
        })
      ).status,
    ).toBe(404);
    expect(
      await db
        .selectFrom('commissary_inventory')
        .selectAll()
        .where('stock_item_id', '=', item)
        .executeTakeFirst(),
    ).toEqual(before);
    await db
      .updateTable('stock_items')
      .set({ is_active: false })
      .where('id', '=', item)
      .execute();
    expect((await post()).status).toBe(404);
    await db
      .updateTable('stock_items')
      .set({ is_active: true })
      .where('id', '=', item)
      .execute();
  });
  it('serializes separate purchases without losing stock and protects recorded history on rollback', async () => {
    const before = await db
      .selectFrom('commissary_inventory')
      .select('quantity_on_hand')
      .where('stock_item_id', '=', item)
      .executeTakeFirstOrThrow();
    const results = await Promise.all(Array.from({ length: 5 }, () => post()));
    expect(results.map((result) => result.status)).toEqual([
      201, 201, 201, 201, 201,
    ]);
    const after = await db
      .selectFrom('commissary_inventory')
      .select('quantity_on_hand')
      .where('stock_item_id', '=', item)
      .executeTakeFirstOrThrow();
    expect(
      Number(after.quantity_on_hand) - Number(before.quantity_on_hand),
    ).toBe(12.5);
    await expect(removePurchaseSchema(db)).rejects.toThrow(
      'Cannot remove direct purchase history',
    );
    expect(
      (
        await request(app.getHttpServer()).get(
          '/direct-purchases/' + results[0].body.id,
        )
      ).status,
    ).toBe(200);
  });
  it('rolls back header, lines and balance when movement posting fails', async () => {
    const key = randomUUID();
    const before = await db
      .selectFrom('commissary_inventory')
      .selectAll()
      .where('stock_item_id', '=', item)
      .executeTakeFirstOrThrow();
    await sql`CREATE FUNCTION purchase_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Simulated movement failure'; END; $$`.execute(
      db,
    );
    await sql`CREATE TRIGGER purchase_test_reject BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION purchase_test_reject()`.execute(
      db,
    );
    try {
      expect((await post(body(), key)).status).toBe(500);
      expect(
        await db
          .selectFrom('supplier_receipts')
          .select('id')
          .where('idempotency_key', '=', key)
          .execute(),
      ).toHaveLength(0);
      expect(
        await db
          .selectFrom('commissary_inventory')
          .selectAll()
          .where('stock_item_id', '=', item)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
    } finally {
      await sql`DROP TRIGGER purchase_test_reject ON inventory_movements`.execute(
        db,
      );
      await sql`DROP FUNCTION purchase_test_reject()`.execute(db);
    }
    expect((await post(body(), key)).status).toBe(201);
  });
  it('filters and paginates purchases on the server and enforces existing read/create grants', async () => {
    for (let i = 0; i < 11; i++)
      expect(
        (await post({ ...body(), receipt_number: `SEARCH-${i}` })).status,
      ).toBe(201);
    const result = await request(app.getHttpServer())
      .get('/direct-purchases')
      .query({
        search: 'SEARCH-',
        page: 2,
        page_size: 10,
        purchased_from: '2026-10-01',
        purchased_to: '2026-10-01',
      });
    expect(result.status).toBe(200);
    expect(result.body.total).toBe(11);
    expect(result.body.items).toHaveLength(1);
    expect(
      (
        await request(app.getHttpServer())
          .get('/direct-purchases')
          .query({ page_size: 20 })
      ).status,
    ).toBe(400);
    permissions = [];
    expect((await post()).status).toBe(403);
    expect(
      (await request(app.getHttpServer()).get('/direct-purchases')).status,
    ).toBe(403);
    permissions = ['supplier_receipts.read'];
    expect((await post()).status).toBe(403);
    expect(
      (await request(app.getHttpServer()).get('/direct-purchases')).status,
    ).toBe(200);
    const naive =
      await sql`SELECT 1 FROM information_schema.columns WHERE table_schema IN ('auth','public') AND data_type='timestamp without time zone'`.execute(
        db,
      );
    expect(naive.rows).toHaveLength(0);
  });
});
