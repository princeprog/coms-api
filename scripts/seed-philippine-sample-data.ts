import '../src/config/load-env';

import { createHash } from 'node:crypto';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import { Pool } from 'pg';
import type { DB } from '../src/database/db';
import {
  branches,
  paymentMethods,
  productRecipes,
  products,
  productCategoryNames,
  sampleUnitCosts,
  stockItems,
  suppliers,
} from './philippine-sample-data';

const seedName = 'coms-philippine-sample-v1';
const openingReason = 'Philippine sample data - opening stock';
type Counts = Record<
  | 'branches'
  | 'suppliers'
  | 'stockItems'
  | 'products'
  | 'menuItems'
  | 'paymentMethods'
  | 'inventoryBalances'
  | 'inventoryMovements'
  | 'recipeLines'
  | 'stockCosts',
  number
>;
const emptyCounts = (): Counts => ({
  branches: 0,
  suppliers: 0,
  stockItems: 0,
  products: 0,
  menuItems: 0,
  paymentMethods: 0,
  inventoryBalances: 0,
  inventoryMovements: 0,
  recipeLines: 0,
  stockCosts: 0,
});

function seedId(key: string): string {
  const bytes = createHash('sha256')
    .update(`${seedName}:${key}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// All quantities stay decimal strings. Whole stock units never get fractional pieces.
function branchQuantity(quantity: string, unit: string, index: number): string {
  const [whole, fraction = ''] = quantity.split('.');
  const scaled = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  const result =
    (scaled * BigInt([100, 120, 90, 110, 100, 70, 85, 60][index])) / 100n;
  if (!['kg', 'L'].includes(unit)) return String(result / 100n);
  return `${result / 100n}.${String(result % 100n).padStart(2, '0')}`;
}

async function populate(tx: Transaction<DB>, actorId: string): Promise<Counts> {
  const counts = emptyCounts();
  const seedBranches: {
    id: string;
    dineIn: boolean;
    takeaway: boolean;
    index: number;
  }[] = [];
  for (const [
    index,
    [code, name, address, dineIn, opened],
  ] of branches.entries()) {
    const id = seedId(`branch:${code}`);
    const existing = await tx
      .selectFrom('branches')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('id', '=', id),
          eb(sql<string>`lower(branch_name)`, '=', name.toLowerCase()),
          eb('code', '=', `PH-${code}`),
        ]),
      )
      .executeTakeFirst();
    const row =
      existing ??
      (await tx
        .insertInto('branches')
        .values({
          id,
          code: `PH-${code}`,
          branch_name: name,
          address,
          date_opened: `${opened}T00:00:00+08:00`,
          has_dine_in: dineIn,
          has_takeaway: true,
          status: 'active',
        })
        .returningAll()
        .executeTakeFirstOrThrow());
    if (!existing) counts.branches++;
    if (row.id === id && row.status === 'active')
      seedBranches.push({
        id,
        dineIn: row.has_dine_in,
        takeaway: row.has_takeaway,
        index,
      });
  }

  for (const [name, contact, address, slug] of suppliers) {
    const id = seedId(`supplier:${slug}`);
    const existing = await tx
      .selectFrom('suppliers')
      .select('id')
      .where((eb) =>
        eb.or([
          eb('id', '=', id),
          eb(sql<string>`lower(supplier_name)`, '=', name.toLowerCase()),
        ]),
      )
      .executeTakeFirst();
    if (existing) continue;
    await tx
      .insertInto('suppliers')
      .values({
        id,
        supplier_name: name,
        contact_person: contact,
        address,
        // Reserved example domain avoids accidentally contacting a real supplier.
        email: `${slug}@example.com`,
        contact_number: null,
      })
      .execute();
    counts.suppliers++;
  }

  for (const [name, kind] of paymentMethods) {
    const id = seedId(`payment:${name}`);
    const existing = await tx
      .selectFrom('payment_methods')
      .select('id')
      .where((eb) =>
        eb.or([
          eb('id', '=', id),
          eb(sql<string>`lower(name)`, '=', name.toLowerCase()),
        ]),
      )
      .executeTakeFirst();
    if (existing) continue;
    await tx.insertInto('payment_methods').values({ id, name, kind }).execute();
    counts.paymentMethods++;
  }

  for (const [name, category, unit, commissaryQty, branchQty] of stockItems) {
    const id = seedId(`stock:${name}`);
    const existing = await tx
      .selectFrom('stock_items')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('id', '=', id),
          eb(sql<string>`lower(stock_item_name)`, '=', name.toLowerCase()),
        ]),
      )
      .executeTakeFirst();
    const row =
      existing ??
      (await tx
        .insertInto('stock_items')
        .values({
          id,
          stock_item_name: name,
          category,
          unit,
          // Only operating supplies stay out of product recipes.
          usage_types:
            category === 'Cleaning supplies'
              ? ['OPERATING_SUPPLY']
              : ['INGREDIENT'],
        })
        .returningAll()
        .executeTakeFirstOrThrow());
    if (!existing) counts.stockItems++;
    // Never add stock to a preexisting item that happens to share a sample name.
    if (row.id !== id || !row.is_active || row.unit !== unit) continue;
    const unitCost = sampleUnitCosts[name];
    if (!unitCost) throw new Error('Missing sample unit cost: ' + name);
    // Only items with no cost yet; real receipts and manual costs win.
    const costed = await tx
      .insertInto('stock_item_costs')
      .values({
        stock_item_id: id,
        average_unit_cost: unitCost,
        cost_source: 'MANUAL',
        updated_by_user_id: actorId,
      })
      .onConflict((c) => c.column('stock_item_id').doNothing())
      .returning('stock_item_id')
      .executeTakeFirst();
    if (costed) counts.stockCosts++;
    const locations = [
      { branchId: null, quantity: commissaryQty },
      ...seedBranches.map((branch) => ({
        branchId: branch.id,
        quantity: branchQuantity(branchQty, unit, branch.index),
      })),
    ];
    for (const { branchId, quantity } of locations) {
      const key = seedId(`opening:${id}:${branchId ?? 'commissary'}`);
      const prior = await tx
        .selectFrom('inventory_movements')
        .select('id')
        .where('idempotency_key', '=', key)
        .executeTakeFirst();
      if (prior) continue;
      let history = tx
        .selectFrom('inventory_movements')
        .select('id')
        .where('stock_item_id', '=', id);
      history = branchId
        ? history.where('branch_id', '=', branchId)
        : history.where('branch_id', 'is', null);
      if (await history.executeTakeFirst()) continue;
      // Existing balances are never replaced, including a deliberately empty balance.
      const inserted = branchId
        ? await tx
            .insertInto('branch_inventory')
            .values({
              branch_id: branchId,
              stock_item_id: id,
              quantity_on_hand: quantity,
            })
            .onConflict((c) =>
              c.columns(['branch_id', 'stock_item_id']).doNothing(),
            )
            .returning('stock_item_id')
            .executeTakeFirst()
        : await tx
            .insertInto('commissary_inventory')
            .values({ stock_item_id: id, quantity_on_hand: quantity })
            .onConflict((c) => c.column('stock_item_id').doNothing())
            .returning('stock_item_id')
            .executeTakeFirst();
      if (!inserted) continue;
      await tx
        .insertInto('inventory_movements')
        .values({
          id: key,
          idempotency_key: key,
          stock_item_id: id,
          branch_id: branchId,
          inventory_scope: branchId ? 'BRANCH' : 'COMMISSARY',
          movement_type: 'ADJUSTMENT',
          quantity_delta: quantity,
          reason: openingReason,
          actor_user_id: actorId,
        })
        .execute();
      counts.inventoryBalances++;
      counts.inventoryMovements++;
    }
  }

  for (const [name, price, description] of products) {
    const categoryName = productCategoryNames[name];
    if (!categoryName)
      throw new Error('Missing explicit sample product category: ' + name);
    const id = seedId(`product:${name}`);
    const existing = await tx
      .selectFrom('products')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('id', '=', id),
          eb(sql<string>`lower(product_name)`, '=', name.toLowerCase()),
        ]),
      )
      .executeTakeFirst();
    // Preserve later category edits on existing products; only new assignments
    // require the original sample category to remain active.
    const category = existing
      ? { id: existing.category_id }
      : await tx
          .selectFrom('product_categories')
          .select('id')
          .where('name', '=', categoryName)
          .where('is_active', '=', true)
          .forShare()
          .executeTakeFirst();
    if (!category)
      throw new Error('Active sample category required: ' + categoryName);
    const product =
      existing ??
      (await tx
        .insertInto('products')
        .values({
          id,
          product_name: name,
          category_id: category.id,
          price,
          description,
          service_types: ['DINE_IN', 'TAKEAWAY'],
        })
        .returningAll()
        .executeTakeFirstOrThrow());
    if (!existing) counts.products++;
    if (product.id !== id || !product.is_active) continue;
    counts.recipeLines += await seedRecipe(tx, id, name);
    for (const branch of seedBranches) {
      const services = product.service_types.filter(
        (service) =>
          (service === 'DINE_IN' && branch.dineIn) ||
          (service === 'TAKEAWAY' && branch.takeaway),
      );
      if (!services.length) continue;
      const inserted = await tx
        .insertInto('branch_products')
        .values({
          branch_id: branch.id,
          product_id: id,
          price: product.price,
          service_types: services,
          is_available: true,
        })
        .onConflict((c) => c.columns(['branch_id', 'product_id']).doNothing())
        .returning('product_id')
        .executeTakeFirst();
      if (inserted) counts.menuItems++;
    }
  }
  return counts;
}

// Fills an empty recipe only; any existing line means the recipe is owned by
// someone and stays untouched. A recipe is written whole or not at all.
async function seedRecipe(
  tx: Transaction<DB>,
  productId: string,
  name: string,
) {
  const recipe = productRecipes[name];
  if (!recipe) throw new Error('Missing sample recipe: ' + name);
  const existing = await tx
    .selectFrom('product_ingredients')
    .select('stock_item_id')
    .where('product_id', '=', productId)
    .executeTakeFirst();
  if (existing) return 0;
  const lines = [];
  for (const [stockName, quantity, scope] of recipe) {
    const stock = await tx
      .selectFrom('stock_items')
      .select(['id', 'is_active', 'usage_types'])
      .where('id', '=', seedId(`stock:${stockName}`))
      .executeTakeFirst();
    if (!stock?.is_active || stock.usage_types.includes('OPERATING_SUPPLY'))
      return 0;
    lines.push({
      product_id: productId,
      stock_item_id: stock.id,
      quantity_required: quantity,
      usage_scope: scope,
      component_type: 'INGREDIENT',
    });
  }
  await tx.insertInto('product_ingredients').values(lines).execute();
  return lines.length;
}

const snapshotTables = [
  'branches',
  'suppliers',
  'stock_items',
  'stock_item_costs',
  'products',
  'product_ingredients',
  'payment_methods',
  'branch_products',
  'commissary_inventory',
  'branch_inventory',
  'inventory_movements',
  'auth.users',
  'auth.roles',
  'auth.branch_users',
] as const;
async function snapshot(tx: Transaction<DB>) {
  const result = new Map<string, Set<string>>();
  for (const table of snapshotTables) {
    const rows = await tx.selectFrom(table).selectAll().execute();
    result.set(table, new Set(rows.map((row) => JSON.stringify(row))));
  }
  return result;
}

async function verify(
  tx: Transaction<DB>,
  before: Awaited<ReturnType<typeof snapshot>>,
) {
  const after = await snapshot(tx);
  for (const [table, rows] of before) {
    for (const row of rows) {
      if (!after.get(table)?.has(row))
        throw new Error(`Existing record changed in ${table}`);
    }
  }
  const balances = await sql<{ mismatches: string }>`
    select count(*)::text as mismatches from (
      select m.stock_item_id, m.branch_id, sum(m.quantity_delta) as quantity
      from inventory_movements m
      where m.stock_item_id in (select stock_item_id from inventory_movements where reason = ${openingReason})
      group by m.stock_item_id, m.branch_id
    ) ledger
    left join commissary_inventory ci on ci.stock_item_id = ledger.stock_item_id and ledger.branch_id is null
    left join branch_inventory bi on bi.stock_item_id = ledger.stock_item_id and bi.branch_id = ledger.branch_id
    where ledger.quantity is distinct from coalesce(ci.quantity_on_hand, bi.quantity_on_hand)
  `.execute(tx);
  if (balances.rows[0].mismatches !== '0')
    throw new Error(
      'Opening balances do not reconcile with the inventory ledger',
    );
  const menu = await tx
    .selectFrom('branch_products as bp')
    .innerJoin('products as p', 'p.id', 'bp.product_id')
    .innerJoin('branches as b', 'b.id', 'bp.branch_id')
    .select([
      'bp.price',
      'p.price as sharedPrice',
      'bp.service_types',
      'b.has_dine_in',
      'b.has_takeaway',
      'p.service_types as productServices',
    ])
    .where(
      'p.id',
      'in',
      products.map(([name]) => seedId(`product:${name}`)),
    )
    .where(
      'b.id',
      'in',
      branches.map(([code]) => seedId(`branch:${code}`)),
    )
    .execute();
  for (const item of menu) {
    if (
      item.price !== item.sharedPrice ||
      !item.service_types.length ||
      item.service_types.some(
        (s) =>
          !item.productServices.includes(s) ||
          (s === 'DINE_IN' ? !item.has_dine_in : !item.has_takeaway),
      )
    ) {
      throw new Error(
        'Menu price or service does not match its product and branch',
      );
    }
  }
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (
    args.some((arg) => !['--apply', '--check'].includes(arg)) ||
    args.length > 1
  )
    throw new Error('Usage: pnpm seed:philippines [--check | --apply]');
  const apply = args.includes('--apply');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const url = new URL(connectionString);
  if (
    process.env.NODE_ENV === 'production' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  ) {
    throw new Error(
      'Sample data is restricted to a local development database',
    );
  }
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString, max: 1 }),
    }),
  });
  const rollback = new Error('CHECK_ONLY_ROLLBACK');
  let summary: Counts | undefined;
  try {
    await db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${seedName}, 0))`.execute(
        tx,
      );
      const admins = await tx
        .selectFrom('auth.users as u')
        .innerJoin('auth.roles as r', 'r.id', 'u.role_id')
        .select('u.id')
        .where('u.is_active', '=', true)
        .where('r.is_active', '=', true)
        .where('r.is_system', '=', true)
        .where('r.code', '=', 'SUPER_ADMIN')
        .execute();
      if (admins.length !== 1)
        throw new Error(
          'Expected one existing active Super Admin for sample opening-stock attribution',
        );
      const before = await snapshot(tx);
      summary = await populate(tx, admins[0].id);
      await verify(tx, before);
      const firstPass = await snapshot(tx);
      const repeated = await populate(tx, admins[0].id);
      if (Object.values(repeated).some((count) => count !== 0))
        throw new Error('Rerunning the seed would create duplicate data');
      await verify(tx, firstPass);
      if (!apply) throw rollback;
    });
    console.log(
      'Sample data committed. Existing records preserved; ledger, menus and repeat-run checks passed.',
    );
  } catch (error) {
    if (error !== rollback) throw error;
    console.log(
      'Dry run passed; all writes rolled back. Existing records, ledger, menus and repeat-run checks passed.',
    );
  } finally {
    await db.destroy();
  }
  console.log(
    JSON.stringify(
      {
        mode: apply ? 'applied' : 'dry-run',
        database: decodeURIComponent(url.pathname.slice(1)),
        added: summary,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Sample data seed failed',
  );
  process.exitCode = 1;
});
