import { sql, type Transaction } from 'kysely';
import { ConflictException } from '@nestjs/common';
import type { DB, Json } from '../../database/db';
import type { OfflineSnapshot } from './offline-sale-writer';

export async function createOfflineSnapshot(
  tx: Transaction<DB>,
  sessionId: string,
  branchId: string,
) {
  // One statement sees one catalog/recipe/cost snapshot under READ COMMITTED.
  // Session preparation can therefore wait for report locks and still observe
  // their committed status, without mixing menu versions between statements.
  const result = await sql<{ snapshot: OfflineSnapshot }>`
    SELECT jsonb_build_object(
      'branch', jsonb_build_object('id',b.id,'name',b.branch_name,
        'supports_dine_in',b.has_dine_in,'supports_takeaway',b.has_takeaway),
      'cash_payment_method', jsonb_build_object('id',cash.id,'name',cash.name),
      'products', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',p.id,'name',p.product_name,'category_id',p.category_id,'category_name',c.name,
        'price',p.price::text,'price_revision',p.price_revision,
        'supports_dine_in',('DINE_IN'=ANY(p.service_types) AND 'DINE_IN'=ANY(bp.service_types)),
        'supports_takeaway',('TAKEAWAY'=ANY(p.service_types) AND 'TAKEAWAY'=ANY(bp.service_types)),
        'recipe',coalesce((SELECT jsonb_agg(jsonb_build_object(
          'stock_item_id',r.stock_item_id,'quantity_required',r.quantity_required::text,
          'usage_scope',r.usage_scope,'unit_cost',cost.average_unit_cost::text
        ) ORDER BY r.stock_item_id,r.usage_scope)
          FROM product_ingredients r LEFT JOIN stock_item_costs cost ON cost.stock_item_id=r.stock_item_id
          WHERE r.product_id=p.id),'[]'::jsonb)
        ) ORDER BY p.id)
        FROM products p JOIN branch_products bp ON bp.product_id=p.id
          JOIN product_categories c ON c.id=p.category_id
        WHERE bp.branch_id=b.id AND bp.is_available AND p.is_active),'[]'::jsonb)
    ) AS snapshot
    FROM branches b CROSS JOIN LATERAL (
      SELECT id,name FROM payment_methods WHERE kind='CASH' AND is_active ORDER BY created_at,id LIMIT 1
    ) cash WHERE b.id=${branchId}::uuid
  `.execute(tx);
  const snapshot = result.rows[0]?.snapshot;
  if (!snapshot)
    throw new ConflictException(
      'Enable a cash payment method before preparing this register.',
    );
  const saved = await tx
    .insertInto('pos_offline_snapshots')
    .values({
      session_id: sessionId,
      payload: JSON.stringify(snapshot) as unknown as Json,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return publicOfflineSnapshot(saved.id, snapshot);
}

export function publicOfflineSnapshot(id: string, snapshot: OfflineSnapshot) {
  return {
    id,
    branch: snapshot.branch,
    cash_payment_method: snapshot.cash_payment_method,
    products: snapshot.products.map(({ recipe: _recipe, ...product }) => ({
      ...product,
      sku: null,
    })),
  };
}
