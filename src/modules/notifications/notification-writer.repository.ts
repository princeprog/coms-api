import { Injectable } from '@nestjs/common';
import { sql, type Insertable, type Transaction } from 'kysely';
import type { DB, NotificationEvents } from '../../database/db';
import {
  notificationPolicy,
  type NotificationKind,
} from './notifications.types';

type NotificationInput = Omit<
  Insertable<NotificationEvents>,
  'kind' | 'id' | 'created_at'
> & { kind: NotificationKind };

// The only cross-module export: writes through the caller's existing transaction.
@Injectable()
export class NotificationWriterRepository {
  async publish(
    transaction: Transaction<DB>,
    input: NotificationInput,
    options: { excludeUserIds?: string[] } = {},
  ) {
    const event = await transaction
      .insertInto('notification_events')
      .values(input)
      .onConflict((conflict) => conflict.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!event) return 0;
    const policy = notificationPolicy[input.kind];
    const result =
      await sql`INSERT INTO notification_recipients (event_id, user_id)
      SELECT ${event.id}::uuid, u.id
      FROM coms_auth.users u JOIN coms_auth.roles r ON r.id = u.role_id
      WHERE u.is_active AND r.is_active AND u.id IS DISTINCT FROM ${input.actor_user_id ?? null}::uuid
      AND ${options.excludeUserIds?.length ? sql`u.id NOT IN (${sql.join(options.excludeUserIds.map((id) => sql`${id}::uuid`))})` : sql`true`}
      AND (
        (r.is_system AND r.code = 'SUPER_ADMIN' AND ${policy.review})
        OR (
          NOT (r.is_system AND r.code = 'SUPER_ADMIN')
          AND EXISTS (SELECT 1 FROM coms_auth.branch_users bu JOIN branches b ON b.id = bu.branch_id
            WHERE bu.user_id = u.id AND b.id = ${input.branch_id}::uuid AND b.status = 'active')
          AND EXISTS (SELECT 1 FROM coms_auth.role_permissions rp JOIN coms_auth.permissions p ON p.id = rp.permission_id
            WHERE rp.role_id = r.id AND p.module_key = ${policy.module} AND p.action_key = 'read')
          AND EXISTS (SELECT 1 FROM coms_auth.role_permissions rp JOIN coms_auth.permissions p ON p.id = rp.permission_id
            WHERE rp.role_id = r.id AND p.module_key = ${policy.module} AND p.action_key IN (${sql.join(policy.actions)}))
        )
      ) ON CONFLICT (event_id, user_id) DO NOTHING RETURNING user_id`.execute(
        transaction,
      );
    return result.rows.length;
  }
}
