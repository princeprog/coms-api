import { sql, type RawBuilder } from 'kysely';

export type ScheduledShift = {
  work_date: string;
  branch_id: string;
  branch_name: string;
  user_id: string;
  full_name: string;
  template_id: string;
  template_name: string;
  start_time: string;
  end_time: string;
  starts_at: Date;
  ends_at: Date;
  source: 'PATTERN' | 'EXTRA';
  exception_id: string | null;
};

type DateInput = string | RawBuilder<unknown>;
const dateSql = (value: DateInput) =>
  typeof value === 'string' ? sql`${value}::date` : value;

/**
 * Who works which shift on each business date in [from, to]: the weekly
 * pattern minus OFF exceptions, plus EXTRA exceptions. Only active shifts at
 * active branches, for active staff still assigned to that branch.
 *
 * A shift belongs to one business date. It starts at the moment within that
 * business day whose Manila time is its start time, so with a 06:00 day start
 * a 02:00 shift falls on the next calendar morning.
 */
export function scheduledShiftsSql(options: {
  from: DateInput;
  to: DateInput;
  branchIds?: string[] | null;
  userIds?: string[];
}): RawBuilder<ScheduledShift> {
  const from = dateSql(options.from);
  const to = dateSql(options.to);
  const branchFilter =
    options.branchIds === undefined || options.branchIds === null
      ? sql``
      : options.branchIds.length
        ? sql`AND o.branch_id IN (${sql.join(options.branchIds)})`
        : sql`AND false`;
  const userFilter = options.userIds
    ? options.userIds.length
      ? sql`AND o.user_id IN (${sql.join(options.userIds)})`
      : sql`AND false`
    : sql``;
  return sql<ScheduledShift>`
    SELECT o.work_date::text AS work_date, o.branch_id, b.branch_name,
      o.user_id, u.full_name, o.template_id, t.name AS template_name,
      to_char(t.start_time, 'HH24:MI') AS start_time,
      to_char(t.end_time, 'HH24:MI') AS end_time,
      timing.starts_at,
      timing.starts_at + CASE WHEN t.end_time > t.start_time
        THEN t.end_time - t.start_time
        ELSE t.end_time - t.start_time + interval '24 hours' END AS ends_at,
      o.source, o.exception_id
    FROM (
      SELECT g.day::date AS work_date, a.branch_id, a.user_id, a.template_id,
        'PATTERN'::text AS source, NULL::uuid AS exception_id
      FROM generate_series(${from}, ${to}, interval '1 day') AS g(day)
      JOIN staff_shift_assignments a ON a.weekday = extract(isodow FROM g.day)
      WHERE NOT EXISTS (
        SELECT 1 FROM staff_shift_exceptions x
        WHERE x.kind = 'OFF' AND x.user_id = a.user_id
          AND x.template_id = a.template_id AND x.work_date = g.day::date)
      UNION ALL
      SELECT x.work_date, x.branch_id, x.user_id, x.template_id, 'EXTRA', x.id
      FROM staff_shift_exceptions x
      WHERE x.kind = 'EXTRA' AND x.work_date BETWEEN ${from} AND ${to}
    ) AS o
    JOIN branch_shift_templates t ON t.id = o.template_id AND t.is_active
    JOIN branches b ON b.id = o.branch_id AND b.status = 'active'
    JOIN coms_auth.users u ON u.id = o.user_id AND u.is_active
    CROSS JOIN LATERAL (
      SELECT ((CASE WHEN t.start_time >=
          (coms_business_day_start(o.work_date) AT TIME ZONE 'Asia/Manila')::time
        THEN o.work_date ELSE o.work_date + 1 END) + t.start_time)
        AT TIME ZONE 'Asia/Manila' AS starts_at
    ) AS timing
    WHERE (o.source = 'EXTRA'
        OR extract(isodow FROM o.work_date)::smallint = ANY(t.weekdays))
      AND EXISTS (SELECT 1 FROM coms_auth.branch_users bu
        WHERE bu.user_id = o.user_id AND bu.branch_id = o.branch_id)
      ${branchFilter} ${userFilter}
  `;
}
