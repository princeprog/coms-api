import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE sales ADD COLUMN occurred_at timestamptz;
    ALTER TABLE sale_events ADD COLUMN occurred_at timestamptz;
    ALTER TABLE inventory_movements ADD COLUMN occurred_at timestamptz;
    UPDATE sales SET occurred_at = created_at;
    UPDATE sale_events SET occurred_at = created_at;
    UPDATE inventory_movements SET occurred_at = created_at;
    ALTER TABLE sales ALTER COLUMN occurred_at SET NOT NULL, ALTER COLUMN occurred_at SET DEFAULT now();
    ALTER TABLE sale_events ALTER COLUMN occurred_at SET NOT NULL, ALTER COLUMN occurred_at SET DEFAULT now();
    ALTER TABLE inventory_movements ALTER COLUMN occurred_at SET NOT NULL, ALTER COLUMN occurred_at SET DEFAULT now();
    CREATE INDEX sales_branch_occurrence ON sales(branch_id, occurred_at, id);
    CREATE INDEX sale_events_occurrence ON sale_events(occurred_at, sale_id);
    CREATE INDEX inventory_movements_branch_occurrence ON inventory_movements(branch_id, occurred_at);
    CREATE TABLE pos_offline_devices (
      id uuid PRIMARY KEY,
      branch_id uuid NOT NULL REFERENCES branches(id),
      name varchar(80) NOT NULL,
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REVOKED')),
      requested_by uuid NOT NULL REFERENCES coms_auth.users(id),
      approved_by uuid REFERENCES coms_auth.users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX pos_offline_devices_branch ON pos_offline_devices(branch_id, status);
    CREATE TABLE pos_offline_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      branch_id uuid NOT NULL REFERENCES branches(id),
      shift_id uuid NOT NULL REFERENCES register_shifts(id),
      cashier_id uuid NOT NULL REFERENCES coms_auth.users(id),
      device_id uuid NOT NULL REFERENCES pos_offline_devices(id),
      business_date date NOT NULL,
      issued_at timestamptz NOT NULL DEFAULT now(),
      cutoff_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','FINALIZED')),
      last_sequence integer NOT NULL DEFAULT 0 CHECK(last_sequence >= 0),
      last_captured_at timestamptz,
      final_sequence integer CHECK(final_sequence >= 0),
      finalized_at timestamptz,
      protocol_version integer NOT NULL DEFAULT 1 CHECK(protocol_version = 1),
      CHECK(cutoff_at > issued_at),
      CHECK((status = 'FINALIZED') = (finalized_at IS NOT NULL AND final_sequence IS NOT NULL))
    );
    CREATE UNIQUE INDEX pos_offline_sessions_open_shift ON pos_offline_sessions(shift_id) WHERE status = 'OPEN';
    CREATE UNIQUE INDEX pos_offline_sessions_open_device ON pos_offline_sessions(device_id) WHERE status = 'OPEN';
    CREATE INDEX pos_offline_sessions_branch_day ON pos_offline_sessions(branch_id, business_date, status);
    CREATE INDEX pos_offline_sessions_cashier ON pos_offline_sessions(cashier_id);
    CREATE TABLE pos_offline_snapshots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id uuid NOT NULL REFERENCES pos_offline_sessions(id),
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX pos_offline_snapshots_session ON pos_offline_snapshots(session_id, created_at);
    CREATE TABLE pos_offline_transactions (
      id uuid PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES pos_offline_sessions(id),
      sequence integer NOT NULL CHECK(sequence > 0),
      snapshot_id uuid NOT NULL REFERENCES pos_offline_snapshots(id),
      payload jsonb NOT NULL,
      fingerprint text NOT NULL,
      status text NOT NULL CHECK(status IN ('ACKNOWLEDGED','NEEDS_REVIEW')),
      reason text,
      sale_id uuid REFERENCES sales(id),
      received_at timestamptz NOT NULL DEFAULT now(),
      reviewed_at timestamptz,
      reviewed_by uuid REFERENCES coms_auth.users(id),
      review_reason varchar(500),
      UNIQUE(session_id, sequence),
      UNIQUE(sale_id),
      CHECK((status = 'ACKNOWLEDGED') = (sale_id IS NOT NULL))
    );
    CREATE INDEX pos_offline_transactions_review ON pos_offline_transactions(session_id, received_at) WHERE status = 'NEEDS_REVIEW';
    CREATE FUNCTION coms_offline_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Offline menu snapshots are immutable'; END;
    $$;
    CREATE TRIGGER pos_offline_snapshot_immutable BEFORE UPDATE OR DELETE ON pos_offline_snapshots
      FOR EACH ROW EXECUTE FUNCTION coms_offline_snapshot_immutable();
    REVOKE ALL ON pos_offline_devices, pos_offline_sessions, pos_offline_snapshots, pos_offline_transactions FROM PUBLIC;
    INSERT INTO coms_auth.permissions(module_key,action_key,description) VALUES
      ('pos_offline','devices_manage','Approve and manage branch register devices'),
      ('pos_offline','review','Review and recover offline sales');
    INSERT INTO coms_auth.role_permissions(role_id,permission_id)
      SELECT r.id,p.id FROM coms_auth.roles r CROSS JOIN coms_auth.permissions p
      WHERE r.is_predefined AND r.code='BRANCH_MANAGER' AND p.module_key='pos_offline'
      ON CONFLICT DO NOTHING;
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM pos_offline_sessions) THEN
        RAISE EXCEPTION 'Offline sessions exist; use a forward correction';
      END IF;
    END $$;
    DROP TABLE pos_offline_transactions;
    DROP TABLE pos_offline_snapshots;
    DROP FUNCTION coms_offline_snapshot_immutable();
    DROP TABLE pos_offline_sessions;
    DROP TABLE pos_offline_devices;
    DELETE FROM coms_auth.role_permissions WHERE permission_id IN(SELECT id FROM coms_auth.permissions WHERE module_key='pos_offline');
    DELETE FROM coms_auth.permissions WHERE module_key='pos_offline';
    ALTER TABLE inventory_movements DROP COLUMN occurred_at;
    ALTER TABLE sale_events DROP COLUMN occurred_at;
    ALTER TABLE sales DROP COLUMN occurred_at;
  `.execute(db);
}
