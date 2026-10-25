import {
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { sql, type Transaction } from 'kysely';
import type { DB } from '../../database/db';
import {
  deductSaleRecipeStock,
  saleReference,
} from '../sales/sales.repository';

export type OfflineSnapshot = {
  branch: {
    id: string;
    name: string;
    supports_dine_in: boolean;
    supports_takeaway: boolean;
  };
  cash_payment_method: { id: string; name: string };
  products: {
    id: string;
    name: string;
    category_id: string;
    category_name: string;
    price: string;
    price_revision: number;
    supports_dine_in: boolean;
    supports_takeaway: boolean;
    recipe: {
      stock_item_id: string;
      quantity_required: string;
      usage_scope: 'ALL' | 'DINE_IN' | 'TAKEAWAY';
      unit_cost: string | null;
    }[];
  }[];
};

export type OfflineEnvelope = {
  id: string;
  session_id: string;
  device_id: string;
  shift_id: string;
  sequence: number;
  snapshot_id: string;
  captured_at: string;
  service_type: 'DINE_IN' | 'TAKEAWAY';
  items: {
    product_id: string;
    quantity: string;
    unit_price: string;
    price_revision: number;
  }[];
  cash_tendered: string;
  total_amount: string;
};

const decimal = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 60 &&
  /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);

function held(): never {
  throw new ConflictException({
    code: 'OFFLINE_SALE_INVALID',
    message:
      'This offline sale does not match its saved menu or cash payment. Hold it for review.',
  });
}

/**
 * The caller authenticates and locks branch -> shift -> session, verifies the
 * envelope/session/device/snapshot binding, and owns rollback (including savepoints).
 * This writer never opens a transaction or reads mutable catalog/cost records.
 */
export async function postOfflineSale(
  tx: Transaction<DB>,
  session: { branch_id: string; cashier_id: string; shift_id: string },
  snapshot: OfflineSnapshot,
  envelope: OfflineEnvelope,
): Promise<{ id: string; sale_reference: string }> {
  const service = envelope.service_type;
  const supports = (value: {
    supports_dine_in: boolean;
    supports_takeaway: boolean;
  }) =>
    service === 'DINE_IN' ? value.supports_dine_in : value.supports_takeaway;
  if (
    snapshot.branch.id !== session.branch_id ||
    envelope.shift_id !== session.shift_id ||
    !['DINE_IN', 'TAKEAWAY'].includes(service) ||
    !supports(snapshot.branch) ||
    !Array.isArray(envelope.items) ||
    !envelope.items.length ||
    envelope.items.length > 40 ||
    !decimal(envelope.total_amount) ||
    !decimal(envelope.cash_tendered) ||
    typeof envelope.captured_at !== 'string' ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(envelope.captured_at) ||
    !isISO8601(envelope.captured_at, { strict: true })
  )
    held();
  const products = new Map(
    snapshot.products.map((product) => [product.id, product]),
  );
  const seen = new Set<string>();
  const lines = envelope.items.map((item) => {
    if (!item || typeof item !== 'object') held();
    const product = products.get(item.product_id);
    if (
      !product ||
      seen.has(item.product_id) ||
      !supports(product) ||
      !Number.isSafeInteger(item.price_revision) ||
      item.price_revision !== product.price_revision ||
      !decimal(item.quantity) ||
      !/[1-9]/.test(item.quantity) ||
      !decimal(item.unit_price)
    )
      held();
    seen.add(item.product_id);
    return { item, product };
  });

  // PostgreSQL numeric performs every financial comparison and calculation.
  // Shape checks above prevent bad numeric casts from aborting the caller's transaction.
  const values = sql.join(
    lines.map(
      ({ item, product }) =>
        sql`(${item.product_id}::uuid, ${item.quantity}::numeric, ${item.unit_price}::numeric, ${product.price}::numeric)`,
    ),
  );
  const validation = await sql<{ valid: boolean }>`
    WITH lines(product_id, quantity, unit_price, saved_price) AS (VALUES ${values})
    SELECT bool_and(quantity > 0 AND unit_price = saved_price AND saved_price >= 0)
      AND sum(quantity * saved_price) = ${envelope.total_amount}::numeric
      AND ${envelope.cash_tendered}::numeric >= ${envelope.total_amount}::numeric AS valid
    FROM lines
  `.execute(tx);
  if (validation.rows[0]?.valid !== true) held();
  const priced = await sql<{ product_id: string; line_total: string }>`
    SELECT product_id::text AS product_id, trim_scale(quantity * saved_price)::text AS line_total
    FROM (VALUES ${values}) AS lines(product_id, quantity, unit_price, saved_price)
  `.execute(tx);
  const totals = new Map(
    priced.rows.map((line) => [line.product_id, line.line_total]),
  );
  const recipeLines = lines.flatMap(({ item, product }) =>
    product.recipe
      .filter(
        (recipe) =>
          recipe.usage_scope === 'ALL' || recipe.usage_scope === service,
      )
      .map(
        (recipe) => sql`(${product.id}::uuid, ${recipe.stock_item_id}::uuid,
      ${item.quantity}::numeric * ${recipe.quantity_required}::numeric, ${recipe.unit_cost}::numeric)`,
      ),
  );
  const consumption = recipeLines.length
    ? (
        await sql<{
          product_id: string;
          stock_item_id: string;
          quantity_consumed: string;
          unit_cost: string | null;
        }>`
    SELECT product_id::text AS product_id, stock_item_id::text AS stock_item_id,
      trim_scale(sum(quantity))::text AS quantity_consumed, unit_cost::text AS unit_cost
    FROM (VALUES ${sql.join(recipeLines)}) AS recipe(product_id, stock_item_id, quantity, unit_cost)
    GROUP BY product_id, stock_item_id, unit_cost ORDER BY stock_item_id, product_id
  `.execute(tx)
      ).rows
    : [];

  const sale = (
    await sql<{ id: string; sale_number: string }>`
    INSERT INTO sales (branch_id, cashier_user_id, status, tender_method, payment_method_id,
      service_type, inventory_deducted, total_amount, idempotency_key, shift_id, payment_kind, occurred_at)
    VALUES (${session.branch_id}::uuid, ${session.cashier_id}::uuid, 'COMPLETED',
      ${snapshot.cash_payment_method.name}, ${snapshot.cash_payment_method.id}::uuid,
      ${service}, ${consumption.length > 0}, ${envelope.total_amount}::numeric,
      ${envelope.id}::uuid, ${session.shift_id}::uuid, ${'CASH'}, ${envelope.captured_at}::timestamptz)
    RETURNING id, sale_number::text
  `.execute(tx)
  ).rows[0];
  if (!sale)
    throw new InternalServerErrorException('Offline sale could not be created');
  const saleItems = await tx
    .insertInto('sale_items')
    .values(
      lines.map(({ item, product }) => {
        const lineTotal = totals.get(product.id);
        if (lineTotal === undefined)
          throw new InternalServerErrorException(
            'Offline sale total could not be calculated',
          );
        return {
          sale_id: sale.id,
          product_id: product.id,
          product_name_snapshot: product.name,
          quantity: item.quantity,
          unit_price: product.price,
          price_revision: product.price_revision,
          line_total: lineTotal,
        };
      }),
    )
    .returning(['id', 'product_id'])
    .execute();
  await deductSaleRecipeStock(
    tx,
    {
      branchId: session.branch_id,
      actorUserId: session.cashier_id,
      occurredAt: envelope.captured_at,
    },
    saleItems,
    consumption,
  );
  await sql`
    INSERT INTO sale_events (sale_id, event_type, actor_user_id, occurred_at)
    VALUES (${sale.id}::uuid, 'COMPLETED', ${session.cashier_id}::uuid, ${envelope.captured_at}::timestamptz)
  `.execute(tx);
  return { id: sale.id, sale_reference: saleReference(sale.sale_number) };
}
