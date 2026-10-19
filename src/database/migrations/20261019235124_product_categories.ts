import { sql, type Kysely } from 'kysely';

// Exact approved names only. Unknown catalog data requires an explicit mapping.
export const categoryProductNames: Record<string, readonly string[]> = {
  'Rice meals': [
    'Beef Caldereta Rice Meal',
    'Beef Pares Rice Bowl',
    'Chicken Adobo Rice Meal',
    'Chicken Inasal Rice Meal',
    'Crispy Fried Chicken Rice Meal',
    'Daing na Bangus Rice Meal',
    'Kare-Kare Rice Meal',
    'Pork Adobo Rice Meal',
    'Pork Sinigang Rice Meal',
    'Pork Sisig Rice Bowl',
    'Rice and Fried Chicken',
  ],
  'Silog meals': ['Bangsilog', 'Longsilog', 'Tapsilog', 'Tocilog'],
  Chicken: ['Roasted Chicken'],
  Noodles: ['Pancit Bihon', 'Pancit Canton'],
  Sides: [
    'Chopsuey',
    'Fried Egg',
    'Garlic Rice',
    'Lumpiang Shanghai - 6 pcs',
    'Steamed Rice',
  ],
  Desserts: ['Buko Pandan', 'Halo-Halo', 'Leche Flan'],
  Beverages: [
    'Bottled Water 500ml',
    'Calamansi Juice 16oz',
    'Cola 330ml',
    'Iced Tea 16oz',
    'Mango Shake 16oz',
    'Mineral Water 300ml',
    'Sago at Gulaman 16oz',
  ],
  'Legacy items': ['Chicken skin sa baboy', 'czxzxc', 'TEST'],
};

export async function up(db: Kysely<any>): Promise<void> {
  // Freeze writes while validating/backfilling so a concurrent insert cannot escape mapping.
  await sql`LOCK TABLE products IN ACCESS EXCLUSIVE MODE`.execute(db);
  const products = await db
    .selectFrom('products')
    .select(['id', 'product_name', 'is_active'])
    .execute();
  const mapping = new Map(
    Object.entries(categoryProductNames).flatMap(([category, names]) =>
      names.map((name) => [name, category] as const),
    ),
  );
  const unmatched = products.filter((p) => !mapping.has(p.product_name));
  if (unmatched.length)
    throw new Error(
      'Unmapped products; approve explicit categories before migrating: ' +
        JSON.stringify(unmatched),
    );
  const invalid = products.filter(
    (p) => p.is_active && mapping.get(p.product_name) === 'Legacy items',
  );
  if (invalid.length)
    throw new Error(
      'Active products cannot enter archived Legacy items: ' +
        JSON.stringify(invalid),
    );
  await sql`CREATE TABLE product_categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 2 AND 80),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX product_categories_name_unique ON product_categories (lower(btrim(name)))`.execute(
    db,
  );
  for (const name of Object.keys(categoryProductNames))
    await db
      .insertInto('product_categories')
      .values({ name, is_active: name !== 'Legacy items' })
      .execute();
  await sql`ALTER TABLE products ADD COLUMN category_id uuid REFERENCES product_categories(id) ON DELETE RESTRICT`.execute(
    db,
  );
  for (const [name, names] of Object.entries(categoryProductNames)) {
    await sql`UPDATE products SET category_id = (SELECT id FROM product_categories WHERE name = ${name}) WHERE product_name IN (${sql.join(names)})`.execute(
      db,
    );
  }
  await sql`ALTER TABLE products ALTER COLUMN category_id SET NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX products_category_id_idx ON products(category_id)`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE products DROP COLUMN category_id`.execute(db);
  await sql`DROP TABLE product_categories`.execute(db);
}
