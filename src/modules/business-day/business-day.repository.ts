import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import { crossesDayStart, timeRange } from '../schedules/schedule-policy';

type Rule = { start_time: string; effective_from: string };

@Injectable()
export class BusinessDayRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  async settings() {
    const result = await sql<{
      business_today: string;
      today_start: Date;
      today_end: Date;
      current: Rule;
      scheduled: Rule | null;
    }>`
      WITH today AS (SELECT coms_business_date(now()) AS d)
      SELECT
        today.d::text AS business_today,
        coms_business_day_start(today.d) AS today_start,
        coms_business_day_end(today.d) AS today_end,
        (SELECT json_build_object(
            'start_time', to_char(rule.start_time, 'HH24:MI'),
            'effective_from', rule.effective_from::text)
          FROM business_day_rules rule WHERE rule.effective_from <= today.d
          ORDER BY rule.effective_from DESC LIMIT 1) AS current,
        (SELECT json_build_object(
            'start_time', to_char(rule.start_time, 'HH24:MI'),
            'effective_from', rule.effective_from::text)
          FROM business_day_rules rule WHERE rule.effective_from > today.d
          ORDER BY rule.effective_from LIMIT 1) AS scheduled
      FROM today
    `.execute(this.db);
    return result.rows[0]!;
  }

  async schedule(
    startTime: string,
    effectiveFrom: string,
    actorUserId: string,
  ) {
    await this.db.transaction().execute(async (transaction) => {
      // Serialize changes so two administrators cannot schedule conflicting rules.
      await sql`LOCK TABLE business_day_rules IN SHARE ROW EXCLUSIVE MODE`.execute(
        transaction,
      );
      const check = await sql<{ in_future: boolean; after_today: boolean }>`
        SELECT
          (${effectiveFrom}::date + ${startTime}::time)::timestamp AT TIME ZONE 'Asia/Manila' > now() AS in_future,
          ${effectiveFrom}::date > coms_business_date(now()) AS after_today
      `.execute(transaction);
      const { in_future, after_today } = check.rows[0]!;
      if (!after_today || !in_future)
        throw new ConflictException(
          'Choose a date after the current business day so the new start time is still in the future',
        );
      // Every branch shift must stay inside one business day.
      const crossing = (
        await sql<{
          name: string;
          branch_name: string;
          start_time: string;
          end_time: string;
        }>`
          SELECT t.name, b.branch_name, to_char(t.start_time, 'HH24:MI') AS start_time,
            to_char(t.end_time, 'HH24:MI') AS end_time
          FROM branch_shift_templates t JOIN branches b ON b.id = t.branch_id
          WHERE t.is_active AND b.status = 'active'
          ORDER BY b.branch_name, t.start_time
        `.execute(transaction)
      ).rows.filter((shift) =>
        crossesDayStart(shift.start_time, shift.end_time, startTime),
      );
      if (crossing.length)
        throw new ConflictException({
          code: 'SHIFT_TEMPLATES_CROSS_DAY_START',
          message: `These shifts would run past a ${startTime} day start: ${crossing
            .map(
              (shift) =>
                `${shift.name} ${timeRange(shift.start_time, shift.end_time)} (${shift.branch_name})`,
            )
            .join(', ')}. Change them first.`,
          shifts: crossing.map(
            (shift) => `${shift.branch_name}: ${shift.name}`,
          ),
        });
      await sql`DELETE FROM business_day_rules WHERE effective_from > coms_business_date(now())`.execute(
        transaction,
      );
      await transaction
        .insertInto('business_day_rules')
        .values({
          effective_from: effectiveFrom,
          start_time: startTime,
          created_by_user_id: actorUserId,
        })
        .execute();
    });
    return this.settings();
  }

  async cancelScheduled() {
    await sql`DELETE FROM business_day_rules WHERE effective_from > coms_business_date(now())`.execute(
      this.db,
    );
    return this.settings();
  }
}
