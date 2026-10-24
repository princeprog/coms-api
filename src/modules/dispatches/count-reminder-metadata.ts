import { sql } from 'kysely';

export type CountReminderMetadata = {
  last_sent_at: string | null;
  next_allowed_at: string | null;
};
// Used by both paginated lists and details; the partial index bounds each lookup.
export const countReminderMetadata = sql<CountReminderMetadata | null>`CASE WHEN b.status = 'active' THEN (
  SELECT json_build_object(
    'last_sent_at', to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'next_allowed_at', to_char((r.created_at + interval '30 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) FROM (SELECT max(e.created_at) AS created_at FROM dispatch_events e
    WHERE e.dispatch_id = d.id AND e.event_type = 'COUNT_REMINDER_SENT') r
) ELSE NULL END`;
