import '../src/config/load-env';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { Pool } from 'pg';
import type { DB } from '../src/database/db';
import { AccessControlRepository } from '../src/modules/access-control/access-control.repository';
import type { AccessContext } from '../src/modules/access-control/access-control.types';
import type { PermissionKey } from '../src/modules/access-control/permission-catalog';
import { NotificationWriterRepository } from '../src/modules/notifications/notification-writer.repository';
import { ShiftsRepository } from '../src/modules/shifts/shifts.repository';
import { ShiftsService } from '../src/modules/shifts/shifts.service';
import { shiftTotals } from '../src/modules/shifts/shift-register';
import { SalesRepository } from '../src/modules/sales/sales.repository';
import { SalesService } from '../src/modules/sales/sales.service';
import { DispatchesRepository } from '../src/modules/dispatches/dispatches.repository';
import { DispatchDraftsRepository } from '../src/modules/dispatches/dispatch-drafts.repository';
import { DispatchPostingRepository } from '../src/modules/dispatches/dispatch-posting.repository';
import { DispatchReceivingRepository } from '../src/modules/dispatches/dispatch-receiving.repository';
import { DispatchLateCountRepository } from '../src/modules/dispatches/dispatch-late-count.repository';
import { DispatchesService } from '../src/modules/dispatches/dispatches.service';
import { DailyReportsRepository } from '../src/modules/daily-reports/daily-reports.repository';
import { DailyReportDirectoryRepository } from '../src/modules/daily-reports/daily-report-directory.repository';
import { DailyReportsService } from '../src/modules/daily-reports/daily-reports.service';

const seedName = 'coms-today-operations-v1';
const branchCode = 'PH-MNL-ERMITA';

function seedId(key: string) {
  const bytes = createHash('sha256').update(`${seedName}:${key}`).digest();
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Reuse the real workflow services, but enlist every repository operation in
// one outer transaction so a failed check or dry run rolls back the whole day.
function enlistedDatabase(tx: Transaction<DB>): Kysely<DB> {
  return new Proxy(tx, {
    get(target, property) {
      if (property === 'transaction')
        return () => ({
          execute: <T>(work: (tx: Transaction<DB>) => T) => work(tx),
        });
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as Kysely<DB>;
}

function permits(
  access: AccessContext,
  branchId: string,
  keys: PermissionKey[],
) {
  return (
    access.accountActive &&
    access.role?.isActive &&
    !access.mustChangePassword &&
    access.branchIds.includes(branchId) &&
    keys.every((key) => access.permissions.includes(key))
  );
}

// Existing rows must survive byte-for-byte; inventory balances are verified
// separately against the append-only ledger. Nothing sensitive is printed.
const preservedTables = [
  'coms_auth.users',
  'coms_auth.roles',
  'coms_auth.branch_users',
  'coms_auth.role_permissions',
  'branches',
  'products',
  'product_ingredients',
  'branch_products',
  'stock_items',
  'payment_methods',
  'sales',
  'sale_items',
  'sale_item_consumptions',
  'sale_events',
  'register_shifts',
  'register_shift_cash_movements',
  'dispatches',
  'dispatch_items',
  'dispatch_receipts',
  'dispatch_receipt_items',
  'dispatch_events',
  'inventory_movements',
  'daily_branch_reports',
  'daily_branch_report_items',
  'daily_branch_report_events',
];

async function snapshot(tx: Transaction<DB>) {
  const result = new Map<string, string[]>();
  for (const table of preservedTables) {
    const rows = await sql<{ fingerprint: string }>`
      select md5(to_jsonb(t)::text) as fingerprint from ${sql.table(table)} as t
      order by fingerprint
    `.execute(tx);
    result.set(
      table,
      rows.rows.map((row) => row.fingerprint),
    );
  }
  return result;
}

async function verifyLedger(tx: Transaction<DB>) {
  const result = await sql<{ mismatches: number }>`
    with balances as (
      select 'COMMISSARY' as scope, null::uuid as branch_id, stock_item_id, quantity_on_hand as quantity
      from commissary_inventory
      union all
      select 'BRANCH', branch_id, stock_item_id, quantity_on_hand from branch_inventory
    ), ledger as (
      select inventory_scope as scope, branch_id, stock_item_id, sum(quantity_delta) as quantity
      from inventory_movements group by inventory_scope, branch_id, stock_item_id
    )
    select count(*)::int as mismatches from balances b full join ledger l
      on b.scope = l.scope and b.branch_id is not distinct from l.branch_id and b.stock_item_id = l.stock_item_id
    where coalesce(b.quantity, 0) <> coalesce(l.quantity, 0)
  `.execute(tx);
  assert.equal(
    result.rows[0].mismatches,
    0,
    'Inventory must reconcile with the ledger',
  );
}

async function populate(tx: Transaction<DB>) {
  const db = enlistedDatabase(tx);
  const day = (
    await sql<{ today: string; calendar_today: string }>`
    select coms_business_date(now())::text as today,
      (now() at time zone 'Asia/Manila')::date::text as calendar_today
  `.execute(tx)
  ).rows[0];
  const branch = await tx
    .selectFrom('branches')
    .selectAll()
    .where('code', '=', branchCode)
    .where('status', '=', 'active')
    .forUpdate()
    .executeTakeFirstOrThrow();
  const key = (name: string) => seedId(`${branch.id}:${day.today}:${name}`);
  const existing = await tx
    .selectFrom('daily_branch_reports')
    .select('id')
    .where('idempotency_key', '=', key('report'))
    .executeTakeFirst();
  if (existing)
    return {
      added: false,
      business_date: day.today,
      branch: branch.branch_name,
      report_id: existing.id,
    };
  assert.equal(
    await tx
      .selectFrom('daily_branch_reports')
      .select('id')
      .where('branch_id', '=', branch.id)
      .where('business_date', '=', sql<Date>`${day.today}::date`)
      .executeTakeFirst(),
    undefined,
    'An existing report must not be overwritten',
  );
  assert.equal(
    await tx
      .selectFrom('register_shifts')
      .select('id')
      .where('branch_id', '=', branch.id)
      .where('status', '=', 'OPEN')
      .executeTakeFirst(),
    undefined,
    'An existing open shift must not be changed',
  );

  const accessRepo = new AccessControlRepository(db);
  const users = await tx
    .selectFrom('coms_auth.users')
    .select('id')
    .where('is_active', '=', true)
    .orderBy('id')
    .execute();
  const contexts: AccessContext[] = [];
  for (const user of users) {
    const access = await accessRepo.findAccessContext(user.id);
    if (access) contexts.push(access);
  }
  const sender = contexts.find(
    (a) =>
      a.accountActive &&
      a.role?.isActive &&
      a.role.isSystem &&
      a.role.code === 'SUPER_ADMIN',
  );
  const manager = contexts.find((a) =>
    permits(a, branch.id, [
      'dispatches.receive',
      'shifts.review',
      'daily_reports.create',
      'daily_reports.update',
    ]),
  );
  const cashier = contexts.find(
    (a) =>
      a.userId !== manager?.userId &&
      permits(a, branch.id, ['shifts.operate', 'sales.create']),
  );
  assert.ok(
    sender && manager && cashier,
    'Requires an existing Super Admin, assigned reviewer and separate cashier',
  );
  const asActor = async <T>(actor: AccessContext, work: () => Promise<T>) => {
    await sql`select set_config('coms.actor_id', ${actor.userId}, true)`.execute(
      tx,
    );
    return work();
  };
  const notifications = new NotificationWriterRepository();
  const shiftsRepo = new ShiftsRepository(db, notifications);
  const shifts = new ShiftsService(shiftsRepo);
  const sales = new SalesService(new SalesRepository(db));
  const dispatchQueries = new DispatchesRepository(db);
  const dispatches = new DispatchesService(
    dispatchQueries,
    new DispatchDraftsRepository(db, dispatchQueries),
    new DispatchPostingRepository(db, dispatchQueries, notifications),
    new DispatchReceivingRepository(
      db,
      dispatchQueries,
      notifications,
      new DispatchLateCountRepository(notifications),
    ),
  );
  const reports = new DailyReportsService(
    new DailyReportsRepository(db, notifications),
    new DailyReportDirectoryRepository(db),
  );
  const stock = await tx
    .selectFrom('stock_items')
    .select(['id', 'stock_item_name'])
    .where('is_active', '=', true)
    .execute();
  const stockId = (name: string) => {
    const item = stock.find((s) => s.stock_item_name === name);
    assert.ok(item, `Missing sample stock item: ${name}`);
    return item.id;
  };
  const deliveries: [string, string][][] = [
    [
      ['Chicken Leg Quarter', '8'],
      ['Dinorado Rice', '15'],
      ['Cooking Oil', '3'],
      ['Kraft Meal Box 750ml', '40'],
    ],
    [
      ['Marinated Chicken Inasal', '24'],
      ['Bottled Water 500ml', '24'],
      ['Cola 330ml', '24'],
    ],
    [
      ['Pork Sisig Mix', '3'],
      ['Wooden Spoon and Fork Set', '30'],
    ],
  ];
  const dispatchIds: string[] = [];
  for (const [index, lines] of deliveries.entries()) {
    const dispatch: Awaited<ReturnType<DispatchesService['send']>> =
      await asActor(sender, () =>
        dispatches.send(
          {
            branch_id: branch.id,
            delivered_by_name: ['Ramon Santos', 'Joel Mendoza', 'Ramon Santos'][
              index
            ],
            receive_by: new Date(Date.now() + 45 * 60_000).toISOString(),
            items: lines.map(([name, quantity]) => ({
              stock_item_id: stockId(name),
              quantity_dispatched: quantity,
            })),
          },
          sender,
          key(`dispatch:${index}`),
        ),
      );
    assert.ok(dispatch);
    dispatchIds.push(dispatch.id);
    if (index < 2) {
      const received: Awaited<ReturnType<DispatchesService['receive']>> =
        await asActor(manager, () =>
          dispatches.receive(
            dispatch.id,
            {
              delivery_date: day.calendar_today,
              note: 'Development sample delivery: complete count, packaging intact.',
              items: dispatch.items.map((item) => ({
                dispatch_item_id: item.id,
                quantity_received: item.quantity_dispatched,
              })),
            },
            manager,
            key(`receive:${index}`),
          ),
        );
      assert.equal(received.status, 'RECEIVED');
    }
  }

  const menu = await tx
    .selectFrom('branch_products as bp')
    .innerJoin('products as p', 'p.id', 'bp.product_id')
    .select([
      'p.id',
      'p.product_name',
      'p.price_revision',
      'p.service_types',
      'bp.service_types as branch_services',
    ])
    .where('bp.branch_id', '=', branch.id)
    .where('bp.is_available', '=', true)
    .where('p.is_active', '=', true)
    .execute();
  const meals = [
    'Crispy Fried Chicken Rice Meal',
    'Chicken Inasal Rice Meal',
    'Chicken Adobo Rice Meal',
    'Pork Sisig Rice Bowl',
    'Beef Pares Rice Bowl',
    'Tapsilog',
    'Pork Adobo Rice Meal',
    'Lumpiang Shanghai - 6 pcs',
  ];
  const drinks = [
    'Bottled Water 500ml',
    'Cola 330ml',
    'Calamansi Juice 16oz',
    'Iced Tea 16oz',
  ];
  const payments = await tx
    .selectFrom('payment_methods')
    .selectAll()
    .where('is_active', '=', true)
    .execute();
  const shiftIds: string[] = [];
  const saleIds: string[] = [];
  const previous = await tx
    .selectFrom('register_shifts')
    .select('left_in_drawer')
    .where('branch_id', '=', branch.id)
    .where('status', '<>', 'OPEN')
    .orderBy('closed_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
  for (let shiftIndex = 0; shiftIndex < 2; shiftIndex++) {
    const opening =
      shiftIndex === 0 ? (previous?.left_in_drawer ?? '1500') : '1500';
    const shift: Awaited<ReturnType<ShiftsService['open']>> = await asActor(
      cashier,
      () =>
        shifts.open(
          branch.id,
          { opening_float: opening },
          cashier,
          key(`shift:${shiftIndex}`),
        ),
    );
    shiftIds.push(shift.id);
    const count = shiftIndex === 0 ? 18 : 12;
    for (let i = 0; i < count; i++) {
      const ordinal = saleIds.length;
      const service = ordinal % 3 === 0 ? 'DINE_IN' : 'TAKEAWAY';
      const quantity = String(1 + (ordinal % 3));
      const names = [
        meals[ordinal % meals.length],
        drinks[ordinal % drinks.length],
      ];
      if (ordinal % 5 === 0) names.push('Leche Flan');
      const paymentName = ['Cash', 'Cash', 'Gcash', 'Cash', 'Maya'][
        ordinal % 5
      ];
      const payment = payments.find(
        (p) => p.name.toLowerCase() === paymentName.toLowerCase(),
      );
      assert.ok(payment, `Missing payment method: ${paymentName}`);
      const sale = await asActor(cashier, () =>
        sales.create(
          branch.id,
          {
            service_type: service,
            tender_method: payment.name,
            payment_method_id: payment.id,
            items: names.map((name) => {
              const product = menu.find((p) => p.product_name === name);
              assert.ok(
                product &&
                  product.service_types.includes(service) &&
                  product.branch_services.includes(service),
                `Unavailable menu item: ${name}`,
              );
              return {
                product_id: product.id,
                price_revision: product.price_revision,
                quantity: name === 'Leche Flan' ? '1' : quantity,
              };
            }),
          },
          cashier.userId,
          key(`sale:${ordinal}`),
        ),
      );
      saleIds.push(sale.id);
    }
    if (shiftIndex === 0) {
      const totals = await shiftTotals(tx, shift.id);
      const closed: Awaited<ReturnType<ShiftsService['close']>> = await asActor(
        cashier,
        () =>
          shifts.close(
            branch.id,
            shift.id,
            {
              counted_cash: totals.expected_cash,
              left_in_drawer: '1500',
            },
            cashier,
            key('close:0'),
          ),
      );
      assert.equal(closed.cash_difference, '0');
      await asActor(manager, () =>
        shifts.review(
          branch.id,
          shift.id,
          {
            note: 'Development sample: cash count and sales reconciled; PHP 1,500 retained for the next shift.',
          },
          manager,
        ),
      );
    }
  }
  let report = await asActor(manager, () =>
    reports.create(
      branch.id,
      { business_date: day.today },
      manager.userId,
      key('report'),
    ),
  );
  if (report.items.length) {
    report = await asActor(manager, () =>
      reports.update(
        branch.id,
        report.id,
        {
          items: report.items.map((item) => {
            assert.ok(
              !item.ledger_closing_quantity.startsWith('-'),
              'Cannot simulate a physical count from negative stock',
            );
            return {
              stock_item_id: item.stock_item_id,
              physical_closing_quantity: item.ledger_closing_quantity,
              waste_quantity: '0',
              adjustment_quantity: '0',
            };
          }),
        },
        manager.userId,
      ),
    );
  }
  await verifyLedger(tx);
  const checks = (
    await sql<{
      bad_sales: number;
      bad_dates: number;
      bad_counts: number;
      total: string;
    }>`
    select
      (select count(*)::int from sales s where s.id in (${sql.join(saleIds)}) and
        (s.total_amount <> (select sum(si.quantity * si.unit_price) from sale_items si where si.sale_id = s.id)
         or s.shift_id not in (${sql.join(shiftIds)}))) as bad_sales,
      (select count(*)::int from sales s where s.id in (${sql.join(saleIds)}) and coms_business_date(s.created_at)::text <> ${day.today}) as bad_dates,
      (select count(*)::int from daily_branch_report_items where daily_branch_report_id = ${report.id}
         and (physical_closing_quantity is null or variance_quantity <> 0)) as bad_counts,
      (select sum(total_amount)::text from sales where id in (${sql.join(saleIds)})) as total
  `.execute(tx)
  ).rows[0];
  assert.equal(checks.bad_sales, 0);
  assert.equal(checks.bad_dates, 0);
  assert.equal(checks.bad_counts, 0);
  assert.equal(report.status, 'DRAFT');
  return {
    added: true,
    business_date: day.today,
    branch: branch.branch_name,
    sales: saleIds.length,
    sales_total: checks.total,
    dispatches: dispatchIds.length,
    shifts: shiftIds.length,
    report_id: report.id,
    report_count_items: report.items.length,
  };
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  assert.ok(
    args.length <= 1 &&
      args.every((arg) => ['--check', '--apply'].includes(arg)),
    'Usage: pnpm seed:today [--check | --apply]',
  );
  const apply = args.includes('--apply');
  const connectionString = process.env.DATABASE_URL;
  assert.ok(connectionString, 'DATABASE_URL is required');
  const url = new URL(connectionString);
  assert.ok(
    process.env.NODE_ENV !== 'production' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'Sample operations require a local development database',
  );
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString, max: 1 }),
    }),
  });
  const rollback = new Error('CHECK_ONLY_ROLLBACK');
  let summary: Awaited<ReturnType<typeof populate>> | undefined;
  try {
    await db
      .transaction()
      .setIsolationLevel('serializable')
      .execute(async (tx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${seedName}, 0))`.execute(
          tx,
        );
        const before = await snapshot(tx);
        summary = await populate(tx);
        const after = await snapshot(tx);
        for (const [table, fingerprints] of before) {
          const current = new Set(after.get(table));
          assert.ok(
            fingerprints.every((f) => current.has(f)),
            `Existing ${table} rows changed`,
          );
        }
        assert.equal(
          (await populate(tx)).added,
          false,
          'Repeat run must add nothing',
        );
        assert.deepEqual(
          await snapshot(tx),
          after,
          'Repeat run changed records',
        );
        if (!apply) throw rollback;
      });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await db.destroy();
  }
  console.log(
    JSON.stringify(
      {
        mode: apply ? 'applied' : 'dry-run (rolled back)',
        database: decodeURIComponent(url.pathname.slice(1)),
        ...summary,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Sample operations failed',
  );
  process.exitCode = 1;
});
