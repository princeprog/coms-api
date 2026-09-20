import type { Kysely } from 'kysely'

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function up(db: Kysely<any>): Promise<void> {
	await db.schema.createSchema('auth').ifNotExists().execute()

	await db.schema
	.createTable('auth.users')
	.addColumn('id','uuid', (column) =>
		column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
	)
	.addColumn('email', 'varchar(320)', (column) => column.notNull().unique())
	.addColumn('full_name', 'varchar(160)', (column) => column.notNull())
	.addColumn('contact_number', 'varchar(30)', (column) => column.notNull().unique())
	.addColumn('hashed_password', 'varchar(255)', (column) => column.notNull())
	.addColumn('created_at', 'timestamp', (column) => column.notNull().defaultTo(db.fn('now')))
	.addColumn('updated_at', 'timestamp', (column) => column.notNull().defaultTo(db.fn('now')))

	.execute()

	await db.schema
	.createTable('auth.sessions')
	.addColumn('id','uuid', (column) => 
		column.primaryKey().defaultTo(db.fn('gen_random_uuid')),
	)
	.addColumn('user_id','uuid', (column)=> 
		column.notNull().references('auth.users.id').onDelete('cascade'),
	)
	.addColumn('token_hash', 'varchar(64)', (column) =>
		column.notNull().unique()
	)
	.addColumn('expires_at', 'timestamp', (column) => column.notNull())
    .addColumn('created_at', 'timestamp', (column) =>
      column.notNull().defaultTo(db.fn('now')),
    )
    .addColumn('revoked_at', 'timestamp')
    .execute();

	await db.schema
	.createIndex('auth_users_id_index')
	.on('auth.users')
	.column('id')
	.execute()

	await db.schema
	.createIndex('auth_users_email_index')
	.on('auth.users')
	.column('email')
	.execute()

	await db.schema
    .createIndex('auth_sessions_user_id_index')
    .on('auth.sessions')
    .column('user_id')
    .execute();

  await db.schema
    .createIndex('auth_sessions_expires_at_index')
    .on('auth.sessions')
    .column('expires_at')
    .execute();
}

// `any` is required here since migrations should be frozen in time. alternatively, keep a "snapshot" db interface.
export async function down(db: Kysely<any>): Promise<void> {
	await db.schema.dropTable('auth.users').ifExists().execute()
	await db.schema.dropTable('auth.sessions').ifExists().execute();
}
