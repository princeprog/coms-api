import {
  BadRequestException,
  Inject,
  Injectable,
  StreamableFile,
} from '@nestjs/common';
import type { Kysely } from 'kysely';
import { CSV_ROW_LIMIT, toCsv, type CsvColumn } from '../../common/utils/csv';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import { recordAudit } from '../audit/audit-recorder';

export type CsvExport<T> = {
  /** Plain-language name recorded in the audit log, e.g. "Sales history". */
  label: string;
  /** File name parts, joined with hyphens after the "coms" prefix. */
  nameParts: (string | null | undefined)[];
  columns: CsvColumn<T>[];
  rows: T[];
  total: number;
  filters: object;
  branchId?: string | null;
};

/** Lists are fetched with one extra row so an oversized export is detected. */
export const exportPage = { page: 1, page_size: CSV_ROW_LIMIT + 1 };

const fileSafe = (part: string) =>
  part
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '');

@Injectable()
export class CsvExportService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<DB>) {}

  assertWithinLimit(total: number) {
    if (total > CSV_ROW_LIMIT)
      throw new BadRequestException({
        code: 'EXPORT_TOO_LARGE',
        message: `This export has ${total.toLocaleString('en-US')} rows. Narrow the filters to ${CSV_ROW_LIMIT.toLocaleString('en-US')} rows or fewer.`,
      });
  }

  async branchCode(branchId: string) {
    const branch = await this.db
      .selectFrom('branches')
      .select(['code', 'branch_name'])
      .where('id', '=', branchId)
      .executeTakeFirst();
    return branch?.code || branch?.branch_name || 'branch';
  }

  async userNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (!unique.length) return new Map<string, string>();
    const users = await this.db
      .selectFrom('auth.users')
      .select(['id', 'full_name'])
      .where('id', 'in', unique)
      .execute();
    return new Map(users.map((user) => [user.id, user.full_name]));
  }

  async file<T>(input: CsvExport<T>) {
    this.assertWithinLimit(input.total);
    const filename =
      ['coms', ...input.nameParts]
        .filter((part): part is string => Boolean(part))
        .map(fileSafe)
        .filter(Boolean)
        .join('-') + '.csv';
    const filters = Object.fromEntries(
      Object.entries(input.filters).filter(
        ([key, value]) =>
          !['page', 'page_size'].includes(key) &&
          value !== undefined &&
          value !== '',
      ),
    );
    await recordAudit(this.db, {
      action: 'export.downloaded',
      entityType: 'export',
      entityLabel: input.label,
      branchId: input.branchId ?? null,
      metadata: { file: filename, rows: input.rows.length, filters },
    });
    return new StreamableFile(Buffer.from(toCsv(input.columns, input.rows)), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /** "2026-10-01_2026-10-21" style range for file names. */
  range(from?: string | null, to?: string | null) {
    if (!from && !to) return 'all-dates';
    return `${from ?? 'start'}_${to ?? 'today'}`;
  }
}
