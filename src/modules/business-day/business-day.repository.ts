import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';

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
