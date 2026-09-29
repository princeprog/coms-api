import { sql, type Kysely } from 'kysely';

const CREATE_DESCRIPTION =
  'Record a supplier delivery and immediately add received quantities to commissary inventory';
const PREVIOUS_CREATE_DESCRIPTION = 'Record supplier receipts';
const POST_DESCRIPTION = 'Post supplier receipts to inventory';

type Permission = { id: string; description: string };
type Grant = { role_id: string; code: string; is_predefined: boolean };

export async function up(db: Kysely<any>): Promise<void> {
  const drafts = await db
    .selectFrom('supplier_receipts')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('status', '=', 'DRAFT')
    .executeTakeFirstOrThrow();
  if (Number(drafts.count) > 0) {
    throw new Error(
      `Supplier receiving migration blocked: ${drafts.count} draft receipt(s) remain. Review and post valid drafts or deliberately remove invalid drafts after a verified backup, then retry.`,
    );
  }

  const auditGaps = await db
    .selectFrom('supplier_receipts')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where((eb) =>
      eb.or([eb('posted_by_user_id', 'is', null), eb('posted_at', 'is', null)]),
    )
    .executeTakeFirstOrThrow();
  if (Number(auditGaps.count) > 0) {
    throw new Error(
      `Supplier receiving migration blocked: ${auditGaps.count} final receipt(s) have incomplete posting audit fields. Repair the records before retrying.`,
    );
  }

  const postPermission = (await db
    .selectFrom('auth.permissions')
    .select(['id', 'description'])
    .where('module_key', '=', 'supplier_receipts')
    .where('action_key', '=', 'post')
    .executeTakeFirst()) as Permission | undefined;
  const createPermission = (await db
    .selectFrom('auth.permissions')
    .select(['id', 'description'])
    .where('module_key', '=', 'supplier_receipts')
    .where('action_key', '=', 'create')
    .executeTakeFirst()) as Permission | undefined;
  if (!postPermission || !createPermission) {
    throw new Error(
      'Supplier receiving migration blocked: expected supplier_receipts.create and supplier_receipts.post catalog entries.',
    );
  }
  if (createPermission.description !== PREVIOUS_CREATE_DESCRIPTION) {
    throw new Error(
      'Supplier receiving migration blocked: supplier_receipts.create description changed from the reviewed value.',
    );
  }

  const grants = (await db
    .selectFrom('auth.role_permissions as rp')
    .innerJoin('auth.roles as r', 'r.id', 'rp.role_id')
    .select(['rp.role_id', 'r.code', 'r.is_predefined'])
    .where('rp.permission_id', '=', postPermission.id)
    .execute()) as Grant[];
  const unexpected = grants.filter(
    (grant) => grant.code !== 'COMMISSARY_MANAGER' || !grant.is_predefined,
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Supplier receiving migration blocked: review supplier_receipts.post grants for ${unexpected.map((grant) => grant.code).join(', ')}. Explicitly decide whether each role should receive supplier_receipts.create before retrying.`,
    );
  }

  await db.schema
    .createTable('migration_supplier_receipt_post_grant_backup')
    .addColumn('role_id', 'bigint', (column) => column.primaryKey())
    .execute();
  if (grants.length > 0) {
    await db
      .insertInto('migration_supplier_receipt_post_grant_backup')
      .values(grants.map(({ role_id }) => ({ role_id })))
      .execute();
  }
  await db.schema
    .createTable('migration_supplier_receipt_create_description_backup')
    .addColumn('description', 'text', (column) => column.notNull())
    .execute();
  await db
    .insertInto('migration_supplier_receipt_create_description_backup')
    .values({ description: createPermission.description })
    .execute();

  await db
    .deleteFrom('auth.role_permissions')
    .where('permission_id', '=', postPermission.id)
    .execute();
  await db
    .deleteFrom('auth.permissions')
    .where('id', '=', postPermission.id)
    .execute();
  await db
    .updateTable('auth.permissions')
    .set({ description: CREATE_DESCRIPTION })
    .where('id', '=', createPermission.id)
    .execute();

  await db.schema
    .alterTable('supplier_receipts')
    .dropConstraint('supplier_receipts_status_valid')
    .execute();
  await db.schema
    .alterTable('supplier_receipts')
    .dropConstraint('supplier_receipts_post_state_consistent')
    .execute();
  await db.schema
    .dropIndex('supplier_receipts_status_received_at_idx')
    .execute();
  await db.schema
    .alterTable('supplier_receipts')
    .renameColumn('posted_by_user_id', 'recorded_by_user_id')
    .execute();
  await db.schema
    .alterTable('supplier_receipts')
    .renameColumn('posted_at', 'recorded_at')
    .execute();
  await sql`
    ALTER TABLE supplier_receipts
      ALTER COLUMN recorded_by_user_id SET NOT NULL,
      ALTER COLUMN recorded_at SET NOT NULL,
      DROP COLUMN status
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  const existingPostPermission = await db
    .selectFrom('auth.permissions')
    .select('id')
    .where('module_key', '=', 'supplier_receipts')
    .where('action_key', '=', 'post')
    .executeTakeFirst();
  if (existingPostPermission) {
    throw new Error(
      'Cannot roll back supplier receiving: supplier_receipts.post was recreated after the migration.',
    );
  }

  const createPermission = await db
    .selectFrom('auth.permissions')
    .select(['id', 'description'])
    .where('module_key', '=', 'supplier_receipts')
    .where('action_key', '=', 'create')
    .executeTakeFirst();
  if (!createPermission || createPermission.description !== CREATE_DESCRIPTION) {
    throw new Error(
      'Cannot roll back supplier receiving because supplier_receipts.create changed after the migration.',
    );
  }

  const backupRoles = await db
    .selectFrom('migration_supplier_receipt_post_grant_backup')
    .select('role_id')
    .execute();
  if (backupRoles.length > 0) {
    const roleIds = backupRoles.map(({ role_id }) => role_id);
    const roles = await db
      .selectFrom('auth.roles')
      .select(['id', 'code', 'is_predefined'])
      .where('id', 'in', roleIds)
      .execute();
    if (
      roles.length !== roleIds.length ||
      roles.some(
        (role) => role.code !== 'COMMISSARY_MANAGER' || !role.is_predefined,
      )
    ) {
      throw new Error(
        'Cannot roll back supplier receiving because the original predefined role grant cannot be restored safely.',
      );
    }
  }

  await db.schema
    .alterTable('supplier_receipts')
    .addColumn('status', 'varchar(16)', (column) =>
      column.notNull().defaultTo('DRAFT'),
    )
    .execute();
  await db
    .updateTable('supplier_receipts')
    .set({ status: 'POSTED' })
    .execute();
  await db.schema
    .alterTable('supplier_receipts')
    .renameColumn('recorded_by_user_id', 'posted_by_user_id')
    .execute();
  await db.schema
    .alterTable('supplier_receipts')
    .renameColumn('recorded_at', 'posted_at')
    .execute();
  await db.schema
    .alterTable('supplier_receipts')
    .alterColumn('posted_by_user_id', (column) => column.dropNotNull())
    .alterColumn('posted_at', (column) => column.dropNotNull())
    .execute();
  await db.schema
    .alterTable('supplier_receipts')
    .addCheckConstraint(
      'supplier_receipts_status_valid',
      sql`status IN ('DRAFT', 'POSTED')`,
    )
    .execute();
  await db.schema
    .alterTable('supplier_receipts')
    .addCheckConstraint(
      'supplier_receipts_post_state_consistent',
      sql`(status = 'DRAFT' AND posted_at IS NULL AND posted_by_user_id IS NULL) OR (status = 'POSTED' AND posted_at IS NOT NULL AND posted_by_user_id IS NOT NULL)`,
    )
    .execute();
  await db.schema
    .createIndex('supplier_receipts_status_received_at_idx')
    .on('supplier_receipts')
    .columns(['status', 'received_at'])
    .execute();

  const oldDescription = await db
    .selectFrom('migration_supplier_receipt_create_description_backup')
    .select('description')
    .executeTakeFirstOrThrow();
  await db
    .updateTable('auth.permissions')
    .set({ description: oldDescription.description })
    .where('id', '=', createPermission.id)
    .execute();
  const permission = await db
    .insertInto('auth.permissions')
    .values({
      module_key: 'supplier_receipts',
      action_key: 'post',
      description: POST_DESCRIPTION,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (backupRoles.length > 0) {
    await db
      .insertInto('auth.role_permissions')
      .values(
        backupRoles.map(({ role_id }) => ({
          role_id,
          permission_id: permission.id,
        })),
      )
      .execute();
  }
  await db.schema
    .dropTable('migration_supplier_receipt_create_description_backup')
    .execute();
  await db.schema
    .dropTable('migration_supplier_receipt_post_grant_backup')
    .execute();
}
