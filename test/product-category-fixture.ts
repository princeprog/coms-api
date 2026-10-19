import { sql } from 'kysely';

// Current-schema fixtures explicitly belong to the migration's active Rice meals category.
export const testProductCategoryId = sql<string>`(SELECT id FROM product_categories WHERE name = 'Rice meals')`;
