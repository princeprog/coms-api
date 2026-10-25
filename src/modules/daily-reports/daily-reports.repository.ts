import { NotificationWriterRepository } from '../notifications/notification-writer.repository';
import { lockReceivingBranch } from '../dispatches/receiving-policy';
import { blockingShifts, reportShiftSummaries } from '../shifts/shift-register';
import {
  pendingReportDeliveries,
  validateReportDeliveries,
} from './report-deliveries';
import type { DeliveryExceptionDto } from './dto/submit-daily-report.dto';
import { requireFinalizedOfflineSessions } from './report-offline-sessions';
import {
  paginatedResult,
  paginationOffset,
} from '../../common/utils/pagination';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DATABASE } from '../../database/database.module';
import type { DB } from '../../database/db';
import type { DailyReportQueryDto } from './dto/daily-report-query.dto';

type DbExecutor = Kysely<DB> | Transaction<DB>;
type ReportEntry = {
  stock_item_id: string;
  physical_closing_quantity: string;
  waste_quantity: string;
  waste_reason: string | null;
  adjustment_quantity: string;
  adjustment_reason: string | null;
};
type LedgerTotals = {
  stock_item_id: string;
  stock_item_name: string;
  unit: string;
  opening_quantity: string;
  receipt_quantity: string;
  sale_consumption_quantity: string;
  sale_void_reversal_quantity: string;
  ledger_adjustment_quantity: string;
  ledger_closing_quantity: string;
};

@Injectable()
export class DailyReportsRepository {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    private readonly notifications: NotificationWriterRepository,
  ) {}

  async list(branchId: string, query: DailyReportQueryDto) {
    await this.requireBranch(this.db, branchId);
    let records = this.db
      .selectFrom('daily_branch_reports')
      .select([
        'id',
        'branch_id',
        'status',
        'idempotency_key',
        'created_by_user_id',
        'submitted_by_user_id',
        'submitted_at',
        'reviewed_by_user_id',
        'reviewed_at',
        'return_reason',
        'created_at',
        'updated_at',
        sql<string>`completed_sales_amount::text`.as('completed_sales_amount'),
        'completed_sales_count',
        sql<string>`voided_sales_amount::text`.as('voided_sales_amount'),
        'voided_sales_count',
        sql<string>`business_date::text`.as('business_date'),
      ])
      .where('branch_id', '=', branchId)
      .orderBy('business_date', 'desc')
      .orderBy('id', 'desc')
      .limit(query.page_size)
      .offset(paginationOffset(query));
    let count = this.db
      .selectFrom('daily_branch_reports')
      .select((expression) => expression.fn.countAll<number>().as('total'))
      .where('branch_id', '=', branchId);
    if (query.status) {
      records = records.where('status', '=', query.status);
      count = count.where('status', '=', query.status);
    }
    const [items, result] = await Promise.all([
      records.execute(),
      count.executeTakeFirstOrThrow(),
    ]);
    return paginatedResult(items, Number(result.total), query);
  }

  find(branchId: string, reportId: string) {
    return this.findDetails(this.db, branchId, reportId);
  }

  async create(
    branchId: string,
    businessDate: string,
    idempotencyKey: string,
    actorUserId: string,
  ) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const retry = await transaction
          .selectFrom('daily_branch_reports')
          .select([
            'id',
            'branch_id',
            sql<string>`business_date::text`.as('business_date'),
          ])
          .where('idempotency_key', '=', idempotencyKey)
          .executeTakeFirst();
        if (retry) {
          if (
            retry.branch_id !== branchId ||
            retry.business_date !== businessDate
          )
            throw new ConflictException(
              'Idempotency key has already been used for another report',
            );
          return this.findDetails(transaction, branchId, retry.id);
        }

        const branch = await transaction
          .selectFrom('branches')
          .select(['id', 'status'])
          .where('id', '=', branchId)
          .forUpdate()
          .executeTakeFirst();
        if (!branch || branch.status !== 'active')
          throw new NotFoundException('Active branch not found');

        const repeatedKey = await transaction
          .selectFrom('daily_branch_reports')
          .select([
            'id',
            'branch_id',
            sql<string>`business_date::text`.as('business_date'),
          ])
          .where('idempotency_key', '=', idempotencyKey)
          .executeTakeFirst();
        if (repeatedKey) {
          if (
            repeatedKey.branch_id !== branchId ||
            repeatedKey.business_date !== businessDate
          )
            throw new ConflictException(
              'Idempotency key has already been used for another report',
            );
          return this.findDetails(transaction, branchId, repeatedKey.id);
        }

        const { today } = await this.manilaToday(transaction);
        if (businessDate > today)
          throw new BadRequestException(
            'A daily report cannot be created for a future business date',
          );

        const existingDate = await transaction
          .selectFrom('daily_branch_reports')
          .select('id')
          .where('branch_id', '=', branchId)
          .where('business_date', '=', sql<Date>`${businessDate}::date`)
          .executeTakeFirst();
        if (existingDate)
          throw new ConflictException(
            'A daily report already exists for this branch and business date',
          );

        const totals = await this.ledgerTotals(
          transaction,
          branchId,
          businessDate,
        );

        const report = await transaction
          .insertInto('daily_branch_reports')
          .values({
            branch_id: branchId,
            business_date: businessDate,
            idempotency_key: idempotencyKey,
            created_by_user_id: actorUserId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await this.refreshSalesSummary(
          transaction,
          report.id,
          branchId,
          businessDate,
        );

        if (totals.length)
          await transaction
            .insertInto('daily_branch_report_items')
            .values(
              totals.map((item) => ({
                daily_branch_report_id: report.id,
                stock_item_id: item.stock_item_id,
                opening_quantity: item.opening_quantity,
                receipt_quantity: item.receipt_quantity,
                sale_consumption_quantity: item.sale_consumption_quantity,
                sale_void_reversal_quantity: item.sale_void_reversal_quantity,
                ledger_adjustment_quantity: item.ledger_adjustment_quantity,
                ledger_closing_quantity: item.ledger_closing_quantity,
                expected_closing_quantity: item.ledger_closing_quantity,
              })),
            )
            .execute();
        await transaction
          .insertInto('daily_branch_report_events')
          .values({
            daily_branch_report_id: report.id,
            event_type: 'CREATED',
            actor_user_id: actorUserId,
          })
          .execute();
        return this.findDetails(transaction, branchId, report.id);
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const existing = await this.db
        .selectFrom('daily_branch_reports')
        .select([
          'id',
          'branch_id',
          sql<string>`business_date::text`.as('business_date'),
        ])
        .where('idempotency_key', '=', idempotencyKey)
        .executeTakeFirst();
      if (
        existing?.branch_id === branchId &&
        existing.business_date === businessDate
      )
        return this.findDetails(this.db, branchId, existing.id);
      if (existing)
        throw new ConflictException(
          'Idempotency key has already been used for another report',
        );
      throw new ConflictException(
        'A daily report already exists for this branch and business date',
      );
    }
  }

  async update(
    branchId: string,
    reportId: string,
    entries: ReportEntry[],
    actorUserId: string,
  ) {
    return this.db.transaction().execute(async (transaction) => {
      const report = await this.lockReport(transaction, branchId, reportId);
      if (report.status !== 'DRAFT' && report.status !== 'RETURNED')
        throw new ConflictException(
          'Only draft or returned reports can be updated',
        );
      await this.requireActiveBranch(transaction, branchId);
      const existingItems = await transaction
        .selectFrom('daily_branch_report_items')
        .select('stock_item_id')
        .where('daily_branch_report_id', '=', reportId)
        .execute();
      this.requireCompleteItemSet(existingItems, entries);
      const totals = await this.ledgerTotals(
        transaction,
        branchId,
        report.business_date,
        existingItems.map((item) => item.stock_item_id),
      );
      const totalsById = new Map(
        totals.map((item) => [item.stock_item_id, item]),
      );
      const valueRows = entries.map((entry) => {
        const total = totalsById.get(entry.stock_item_id);
        if (!total)
          throw new NotFoundException('A report stock item no longer exists');
        return sql`(
          ${entry.stock_item_id}::uuid,
          ${total.opening_quantity}::numeric,
          ${total.receipt_quantity}::numeric,
          ${total.sale_consumption_quantity}::numeric,
          ${total.sale_void_reversal_quantity}::numeric,
          ${total.ledger_adjustment_quantity}::numeric,
          ${total.ledger_closing_quantity}::numeric,
          ${entry.physical_closing_quantity}::numeric,
          ${entry.waste_quantity}::numeric,
          ${entry.waste_reason}::text,
          ${entry.adjustment_quantity}::numeric,
          ${entry.adjustment_reason}::text
        )`;
      });
      await sql`
        WITH supplied (
          stock_item_id,
          opening_quantity,
          receipt_quantity,
          sale_consumption_quantity,
          sale_void_reversal_quantity,
          ledger_adjustment_quantity,
          ledger_closing_quantity,
          physical_closing_quantity,
          waste_quantity,
          waste_reason,
          adjustment_quantity,
          adjustment_reason
        ) AS (VALUES ${sql.join(valueRows)})
        UPDATE daily_branch_report_items AS item
        SET opening_quantity = supplied.opening_quantity,
            receipt_quantity = supplied.receipt_quantity,
            sale_consumption_quantity = supplied.sale_consumption_quantity,
            sale_void_reversal_quantity = supplied.sale_void_reversal_quantity,
            ledger_adjustment_quantity = supplied.ledger_adjustment_quantity,
            ledger_closing_quantity = supplied.ledger_closing_quantity,
            physical_closing_quantity = supplied.physical_closing_quantity,
            waste_quantity = supplied.waste_quantity,
            waste_reason = supplied.waste_reason,
            adjustment_quantity = supplied.adjustment_quantity,
            adjustment_reason = supplied.adjustment_reason,
            expected_closing_quantity = supplied.ledger_closing_quantity
              - supplied.waste_quantity + supplied.adjustment_quantity,
            variance_quantity = supplied.physical_closing_quantity
              - (supplied.ledger_closing_quantity - supplied.waste_quantity
                + supplied.adjustment_quantity),
            updated_at = now()
        FROM supplied
        WHERE item.daily_branch_report_id = ${reportId}
          AND item.stock_item_id = supplied.stock_item_id
      `.execute(transaction);
      await this.refreshSalesSummary(
        transaction,
        reportId,
        branchId,
        report.business_date,
      );
      await transaction
        .insertInto('daily_branch_report_events')
        .values({
          daily_branch_report_id: reportId,
          event_type: 'UPDATED',
          actor_user_id: actorUserId,
        })
        .execute();
      return this.findDetails(transaction, branchId, reportId);
    });
  }

  async submit(
    branchId: string,
    reportId: string,
    actorUserId: string,
    exceptions: DeliveryExceptionDto[] = [],
  ) {
    return this.db.transaction().execute(async (transaction) => {
      const report = await this.lockReport(
        transaction,
        branchId,
        reportId,
        true,
      );
      if (report.status === 'SUBMITTED' || report.status === 'APPROVED')
        return this.findDetails(transaction, branchId, reportId);
      if (report.status !== 'DRAFT' && report.status !== 'RETURNED')
        throw new ConflictException('This report cannot be submitted');
      await requireFinalizedOfflineSessions(
        transaction,
        branchId,
        report.business_date,
      );
      const bypassChecklist = process.env.NODE_ENV === 'development';
      const deliveryExceptions = bypassChecklist
        ? []
        : await validateReportDeliveries(
            transaction,
            branchId,
            report.business_date,
            exceptions,
          );
      await this.requireActiveBranch(transaction, branchId);
      if (!bypassChecklist) {
        const { today } = await this.manilaToday(transaction);
        if (report.business_date >= today)
          throw new ConflictException(
            'Reports can be submitted after the business day has ended',
          );
        const shifts = await blockingShifts(
          transaction,
          branchId,
          report.business_date,
        );
        if (shifts.open.length)
          throw new ConflictException(
            `Close shift ${shifts.open.join(', ')} before submitting this report`,
          );
        if (shifts.unreviewed.length)
          throw new ConflictException(
            `A manager must review shift ${shifts.unreviewed.join(', ')} before this report can be submitted`,
          );
      }
      const reportItems = await transaction
        .selectFrom('daily_branch_report_items')
        .selectAll()
        .where('daily_branch_report_id', '=', reportId)
        .execute();
      if (
        !bypassChecklist &&
        reportItems.some((item) => item.physical_closing_quantity === null)
      )
        throw new ConflictException(
          'Enter a physical closing count for every report item before submission',
        );

      const totals = await this.ledgerTotals(
        transaction,
        branchId,
        report.business_date,
        reportItems.map((item) => item.stock_item_id),
      );
      if (reportItems.length)
        await this.refreshReportItems(
          transaction,
          reportId,
          reportItems,
          totals,
        );
      await this.refreshSalesSummary(
        transaction,
        reportId,
        branchId,
        report.business_date,
      );
      await transaction
        .updateTable('daily_branch_reports')
        .set({
          status: 'SUBMITTED',
          submitted_by_user_id: actorUserId,
          submitted_at: sql<Date>`now()`,
          reviewed_by_user_id: null,
          reviewed_at: null,
          return_reason: null,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', reportId)
        .execute();
      const notificationSource = await transaction
        .insertInto('daily_branch_report_events')
        .values({
          daily_branch_report_id: reportId,
          event_type: 'SUBMITTED',
          actor_user_id: actorUserId,
          note: bypassChecklist
            ? 'Submission checklist bypassed in development.'
            : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.notifications.publish(transaction, {
        kind: 'REPORT_SUBMITTED',
        report_event_id: notificationSource.id,
        report_id: reportId,
        branch_id: branchId,
        actor_user_id: actorUserId,
      });
      if (deliveryExceptions.length)
        await transaction
          .insertInto('daily_report_delivery_exceptions')
          .values(
            deliveryExceptions.map((item) => ({
              report_event_id: notificationSource.id,
              dispatch_id: item.dispatch_id,
              reason: item.reason.trim(),
            })),
          )
          .execute();
      return this.findDetails(transaction, branchId, reportId);
    });
  }

  async returnForCorrection(
    branchId: string,
    reportId: string,
    reason: string,
    actorUserId: string,
    allowInactiveBranch = false,
  ) {
    return this.db.transaction().execute(async (transaction) => {
      const report = await this.lockReport(transaction, branchId, reportId);
      if (report.status === 'RETURNED' && report.return_reason === reason)
        return this.findDetails(transaction, branchId, reportId);
      if (report.status !== 'SUBMITTED')
        throw new ConflictException('Only submitted reports can be returned');
      await this.requireActiveBranch(
        transaction,
        branchId,
        allowInactiveBranch,
      );
      await transaction
        .updateTable('daily_branch_reports')
        .set({
          status: 'RETURNED',
          reviewed_by_user_id: actorUserId,
          reviewed_at: sql<Date>`now()`,
          return_reason: reason,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', reportId)
        .execute();
      const notificationSource = await transaction
        .insertInto('daily_branch_report_events')
        .values({
          daily_branch_report_id: reportId,
          event_type: 'RETURNED',
          actor_user_id: actorUserId,
          note: reason,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.notifications.publish(transaction, {
        kind: 'REPORT_RETURNED',
        report_event_id: notificationSource.id,
        report_id: reportId,
        branch_id: branchId,
        actor_user_id: actorUserId,
      });
      return this.findDetails(transaction, branchId, reportId);
    });
  }

  async approve(
    branchId: string,
    reportId: string,
    actorUserId: string,
    allowInactiveBranch = false,
  ) {
    return this.db.transaction().execute(async (transaction) => {
      const report = await this.lockReport(
        transaction,
        branchId,
        reportId,
        true,
      );
      if (report.status === 'APPROVED')
        return this.findDetails(transaction, branchId, reportId);
      if (report.status !== 'SUBMITTED')
        throw new ConflictException('Only submitted reports can be approved');
      await requireFinalizedOfflineSessions(
        transaction,
        branchId,
        report.business_date,
      );
      const held = await transaction
        .selectFrom('dispatch_late_counts as lc')
        .innerJoin('dispatches as d', 'd.id', 'lc.dispatch_id')
        .select('lc.id')
        .where('d.branch_id', '=', branchId)
        .where('lc.status', '=', 'PENDING')
        .where(
          'lc.delivery_date',
          '<=',
          sql<Date>`${report.business_date}::date`,
        )
        .executeTakeFirst();
      if (held)
        throw new ConflictException(
          'Return this report and resolve its late delivery count before approval',
        );
      await this.requireActiveBranch(
        transaction,
        branchId,
        allowInactiveBranch,
      );
      const items = await transaction
        .selectFrom('daily_branch_report_items')
        .select([
          'id',
          'stock_item_id',
          'ledger_closing_quantity',
          'physical_closing_quantity',
          sql<boolean>`physical_closing_quantity <> ledger_closing_quantity`.as(
            'requires_adjustment',
          ),
        ])
        .where('daily_branch_report_id', '=', reportId)
        .orderBy('stock_item_id')
        .forUpdate()
        .execute();
      if (items.some((item) => item.physical_closing_quantity === null))
        throw new ConflictException(
          'A physical closing count is required for every report item',
        );

      const adjustedItems = items.filter((item) => item.requires_adjustment);
      if (adjustedItems.length) {
        await transaction
          .insertInto('branch_inventory')
          .values(
            adjustedItems.map((item) => ({
              branch_id: branchId,
              stock_item_id: item.stock_item_id,
              quantity_on_hand: '0',
            })),
          )
          .onConflict((conflict) =>
            conflict.columns(['branch_id', 'stock_item_id']).doNothing(),
          )
          .execute();
        const balances = await transaction
          .selectFrom('branch_inventory')
          .select(['stock_item_id'])
          .where('branch_id', '=', branchId)
          .where(
            'stock_item_id',
            'in',
            adjustedItems.map((item) => item.stock_item_id),
          )
          .orderBy('stock_item_id')
          .forUpdate()
          .execute();
        if (balances.length !== adjustedItems.length)
          throw new ConflictException(
            'Branch inventory changed while this report was being approved',
          );

        for (const item of adjustedItems) {
          const physical = item.physical_closing_quantity!;
          const balance = await transaction
            .updateTable('branch_inventory')
            .set({
              quantity_on_hand: sql<string>`quantity_on_hand
                + (${physical}::numeric - ${item.ledger_closing_quantity}::numeric)`,
              updated_at: sql<Date>`now()`,
            })
            .where('branch_id', '=', branchId)
            .where('stock_item_id', '=', item.stock_item_id)
            .returning('quantity_on_hand')
            .executeTakeFirst();
          if (!balance)
            throw new ConflictException(
              'Branch inventory changed while this report was being approved',
            );
          await transaction
            .insertInto('inventory_movements')
            .values({
              inventory_scope: 'BRANCH',
              branch_id: branchId,
              stock_item_id: item.stock_item_id,
              movement_type: 'REPORT_ADJUSTMENT',
              quantity_delta: sql<string>`(${physical}::numeric
                - ${item.ledger_closing_quantity}::numeric)`,
              reason: `Approved daily report ${report.business_date}; physical closing ${physical}, ledger closing ${item.ledger_closing_quantity}`,
              actor_user_id: actorUserId,
              daily_branch_report_item_id: item.id,
            })
            .execute();
        }
      }

      await this.refreshSalesSummary(
        transaction,
        reportId,
        branchId,
        report.business_date,
      );

      // Value variance and waste at the cost in effect when the count is approved.
      await sql`
        UPDATE daily_branch_report_items AS i
        SET unit_cost = c.average_unit_cost
        FROM stock_item_costs AS c
        WHERE c.stock_item_id = i.stock_item_id
          AND i.daily_branch_report_id = ${reportId}::uuid
      `.execute(transaction);
      await transaction
        .updateTable('daily_branch_reports')
        .set({
          status: 'APPROVED',
          reviewed_by_user_id: actorUserId,
          reviewed_at: sql<Date>`now()`,
          return_reason: null,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', reportId)
        .execute();
      const notificationSource = await transaction
        .insertInto('daily_branch_report_events')
        .values({
          daily_branch_report_id: reportId,
          event_type: 'APPROVED',
          actor_user_id: actorUserId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.notifications.publish(transaction, {
        kind: 'REPORT_APPROVED',
        report_event_id: notificationSource.id,
        report_id: reportId,
        branch_id: branchId,
        actor_user_id: actorUserId,
      });
      return this.findDetails(transaction, branchId, reportId);
    });
  }

  private async refreshSalesSummary(
    executor: DbExecutor,
    reportId: string,
    branchId: string,
    businessDate: string,
  ) {
    await sql`
      WITH bounds AS (
        SELECT
          coms_business_day_start(${businessDate}::date) AS day_start,
          coms_business_day_end(${businessDate}::date) AS day_end
      ), summary AS (
        SELECT
          coalesce(sum(sale.total_amount)
            FILTER (WHERE event.event_type = 'COMPLETED'), 0) AS completed_amount,
          count(*) FILTER (WHERE event.event_type = 'COMPLETED')::int AS completed_count,
          coalesce(sum(sale.total_amount)
            FILTER (WHERE event.event_type = 'VOIDED'), 0) AS voided_amount,
          count(*) FILTER (WHERE event.event_type = 'VOIDED')::int AS voided_count
        FROM sale_events AS event
        JOIN sales AS sale ON sale.id = event.sale_id
        CROSS JOIN bounds
        WHERE sale.branch_id = ${branchId}
          AND event.occurred_at >= bounds.day_start
          AND event.occurred_at < bounds.day_end
      )
      UPDATE daily_branch_reports AS report
      SET completed_sales_amount = summary.completed_amount,
          completed_sales_count = summary.completed_count,
          voided_sales_amount = summary.voided_amount,
          voided_sales_count = summary.voided_count,
          updated_at = now()
      FROM summary
      WHERE report.id = ${reportId} AND report.status <> 'APPROVED'
    `.execute(executor);
  }

  private async refreshReportItems(
    transaction: Transaction<DB>,
    reportId: string,
    items: {
      stock_item_id: string;
      physical_closing_quantity: string | null;
      waste_quantity: string;
      waste_reason: string | null;
      adjustment_quantity: string;
      adjustment_reason: string | null;
    }[],
    totals: LedgerTotals[],
  ) {
    const totalsById = new Map(
      totals.map((item) => [item.stock_item_id, item]),
    );
    const valueRows = items.map((item) => {
      const total = totalsById.get(item.stock_item_id);
      if (!total)
        throw new NotFoundException('A report stock item no longer exists');
      return sql`(
        ${item.stock_item_id}::uuid,
        ${total.opening_quantity}::numeric,
        ${total.receipt_quantity}::numeric,
        ${total.sale_consumption_quantity}::numeric,
        ${total.sale_void_reversal_quantity}::numeric,
        ${total.ledger_adjustment_quantity}::numeric,
        ${total.ledger_closing_quantity}::numeric
      )`;
    });
    await sql`
      WITH ledger (
        stock_item_id,
        opening_quantity,
        receipt_quantity,
        sale_consumption_quantity,
        sale_void_reversal_quantity,
        ledger_adjustment_quantity,
        ledger_closing_quantity
      ) AS (VALUES ${sql.join(valueRows)})
      UPDATE daily_branch_report_items AS item
      SET opening_quantity = ledger.opening_quantity,
          receipt_quantity = ledger.receipt_quantity,
          sale_consumption_quantity = ledger.sale_consumption_quantity,
          sale_void_reversal_quantity = ledger.sale_void_reversal_quantity,
          ledger_adjustment_quantity = ledger.ledger_adjustment_quantity,
          ledger_closing_quantity = ledger.ledger_closing_quantity,
          expected_closing_quantity = ledger.ledger_closing_quantity
            - item.waste_quantity + item.adjustment_quantity,
          variance_quantity = CASE
            WHEN item.physical_closing_quantity IS NULL THEN NULL
            ELSE item.physical_closing_quantity - (ledger.ledger_closing_quantity
              - item.waste_quantity + item.adjustment_quantity)
          END,
          updated_at = now()
      FROM ledger
      WHERE item.daily_branch_report_id = ${reportId}
        AND item.stock_item_id = ledger.stock_item_id
    `.execute(transaction);
  }

  private async ledgerTotals(
    executor: DbExecutor,
    branchId: string,
    businessDate: string,
    includeStockItemIds?: string[],
  ): Promise<LedgerTotals[]> {
    const includeInactive = includeStockItemIds?.length
      ? sql`OR item.id IN (${sql.join(includeStockItemIds)})`
      : sql``;
    // Report membership is fixed at creation; later setting changes only affect new reports.
    const countScope =
      includeStockItemIds === undefined
        ? sql`item.daily_count_required`
        : includeStockItemIds.length
          ? sql`item.id IN (${sql.join(includeStockItemIds)})`
          : sql`false`;
    const result = await sql<LedgerTotals>`
      WITH day_bounds AS (
        SELECT
          ${businessDate}::date AS business_date,
          coms_business_day_start(${businessDate}::date) AS day_start,
          coms_business_day_end(${businessDate}::date) AS day_end
      ), branch_stock AS (
        SELECT stock_item_id
        FROM branch_inventory
        WHERE branch_id = ${branchId}
      ), movement_totals AS (
        SELECT
          movement.stock_item_id,
          COALESCE(SUM(movement.quantity_delta)
            FILTER (WHERE
              (movement.movement_type = 'REPORT_ADJUSTMENT'
                AND source_report.business_date < bounds.business_date)
              OR (movement.movement_type <> 'REPORT_ADJUSTMENT'
                AND coalesce(coms_business_day_start(receipt.delivery_date), movement.occurred_at) < bounds.day_start)), 0)::text
            AS opening_quantity,
          COALESCE(SUM(movement.quantity_delta)
            FILTER (WHERE coalesce(coms_business_day_start(receipt.delivery_date), movement.occurred_at) >= bounds.day_start
              AND movement.movement_type IN ('TRANSFER_IN', 'RECEIPT')), 0)::text
            AS receipt_quantity,
          COALESCE(SUM(-movement.quantity_delta)
            FILTER (WHERE coalesce(coms_business_day_start(receipt.delivery_date), movement.occurred_at) >= bounds.day_start
              AND movement.movement_type = 'SALE'), 0)::text
            AS sale_consumption_quantity,
          COALESCE(SUM(movement.quantity_delta)
            FILTER (WHERE coalesce(coms_business_day_start(receipt.delivery_date), movement.occurred_at) >= bounds.day_start
              AND movement.movement_type = 'SALE_VOID'), 0)::text
            AS sale_void_reversal_quantity,
          COALESCE(SUM(movement.quantity_delta)
            FILTER (WHERE coalesce(coms_business_day_start(receipt.delivery_date), movement.occurred_at) >= bounds.day_start
              AND movement.movement_type = 'ADJUSTMENT'
              OR (movement.movement_type = 'REPORT_ADJUSTMENT'
                AND source_report.business_date = bounds.business_date)), 0)::text
            AS ledger_adjustment_quantity,
          COALESCE(SUM(movement.quantity_delta), 0)::text AS ledger_closing_quantity
        FROM inventory_movements AS movement
        LEFT JOIN dispatch_receipt_items AS receipt_item ON receipt_item.id = movement.dispatch_receipt_item_id
        LEFT JOIN dispatch_receipts AS receipt ON receipt.id = receipt_item.dispatch_receipt_id
        CROSS JOIN day_bounds AS bounds
        LEFT JOIN daily_branch_report_items AS source_item
          ON source_item.id = movement.daily_branch_report_item_id
        LEFT JOIN daily_branch_reports AS source_report
          ON source_report.id = source_item.daily_branch_report_id
        WHERE movement.inventory_scope = 'BRANCH'
          AND movement.branch_id = ${branchId}
          AND (
            (movement.movement_type = 'REPORT_ADJUSTMENT'
              AND source_report.business_date < bounds.business_date + 1)
            OR (movement.movement_type <> 'REPORT_ADJUSTMENT'
              AND coalesce(coms_business_day_start(receipt.delivery_date), movement.occurred_at) < bounds.day_end)
          )
        GROUP BY movement.stock_item_id
      )
      SELECT
        item.id AS stock_item_id,
        item.stock_item_name,
        item.unit,
        COALESCE(totals.opening_quantity, '0') AS opening_quantity,
        COALESCE(totals.receipt_quantity, '0') AS receipt_quantity,
        COALESCE(totals.sale_consumption_quantity, '0') AS sale_consumption_quantity,
        COALESCE(totals.sale_void_reversal_quantity, '0') AS sale_void_reversal_quantity,
        COALESCE(totals.ledger_adjustment_quantity, '0') AS ledger_adjustment_quantity,
        COALESCE(totals.ledger_closing_quantity, '0') AS ledger_closing_quantity
      FROM stock_items AS item
      CROSS JOIN day_bounds AS bounds
      LEFT JOIN movement_totals AS totals ON totals.stock_item_id = item.id
      LEFT JOIN branch_stock ON branch_stock.stock_item_id = item.id
      WHERE item.created_at < bounds.day_end
        AND ${countScope}
        AND (branch_stock.stock_item_id IS NOT NULL
          OR totals.stock_item_id IS NOT NULL ${includeInactive})
      ORDER BY item.stock_item_name, item.id
    `.execute(executor);
    return result.rows;
  }

  private async findDetails(
    executor: DbExecutor,
    branchId: string,
    reportId: string,
  ) {
    const report = await executor
      .selectFrom('daily_branch_reports')
      .select([
        'id',
        'branch_id',
        'status',
        'idempotency_key',
        'created_by_user_id',
        'submitted_by_user_id',
        'submitted_at',
        'reviewed_by_user_id',
        'reviewed_at',
        'return_reason',
        'created_at',
        'updated_at',
        sql<string>`completed_sales_amount::text`.as('completed_sales_amount'),
        'completed_sales_count',
        sql<string>`voided_sales_amount::text`.as('voided_sales_amount'),
        'voided_sales_count',
        sql<string>`business_date::text`.as('business_date'),
        // Same rule as submit: the report's business day is before today's.
        sql<boolean>`coms_business_date(now()) > business_date`.as(
          'business_day_ended',
        ),
      ])
      .where('id', '=', reportId)
      .where('branch_id', '=', branchId)
      .executeTakeFirst();
    if (!report) throw new NotFoundException('Daily report not found');

    const [items, events] = await Promise.all([
      executor
        .selectFrom('daily_branch_report_items as report_item')
        .innerJoin(
          'stock_items as stock_item',
          'stock_item.id',
          'report_item.stock_item_id',
        )
        .select([
          'report_item.id',
          'report_item.stock_item_id',
          'stock_item.stock_item_name',
          'stock_item.unit',
          'report_item.opening_quantity',
          'report_item.receipt_quantity',
          'report_item.sale_consumption_quantity',
          'report_item.sale_void_reversal_quantity',
          'report_item.ledger_adjustment_quantity',
          'report_item.ledger_closing_quantity',
          'report_item.waste_quantity',
          'report_item.waste_reason',
          'report_item.adjustment_quantity',
          'report_item.adjustment_reason',
          'report_item.expected_closing_quantity',
          'report_item.physical_closing_quantity',
          'report_item.variance_quantity',
        ])
        .where('report_item.daily_branch_report_id', '=', reportId)
        .orderBy('stock_item.stock_item_name')
        .orderBy('report_item.stock_item_id')
        .execute(),
      executor
        .selectFrom('daily_branch_report_events as event')
        .innerJoin(
          'coms_auth.users as actor',
          'actor.id',
          'event.actor_user_id',
        )
        .select([
          'event.id',
          'event.event_type',
          'event.actor_user_id',
          'actor.full_name as actor_name',
          'event.note',
          'event.created_at',
        ])
        .where('event.daily_branch_report_id', '=', reportId)
        .orderBy('event.created_at')
        .orderBy('event.id')
        .execute(),
    ]);
    const pending_deliveries = await pendingReportDeliveries(
      executor,
      branchId,
      report.business_date,
    );
    const shifts = await reportShiftSummaries(
      executor,
      branchId,
      report.business_date,
    );
    const delivery_exceptions = await executor
      .selectFrom('daily_report_delivery_exceptions as x')
      .innerJoin('daily_branch_report_events as e', 'e.id', 'x.report_event_id')
      .innerJoin('dispatches as d', 'd.id', 'x.dispatch_id')
      .select([
        'x.dispatch_id',
        'x.reason',
        'e.actor_user_id',
        'e.created_at',
        'd.counted_at',
        'x.report_event_id',
      ])
      .where('e.daily_branch_report_id', '=', reportId)
      .orderBy('e.created_at', 'desc')
      .execute();
    return {
      ...report,
      submission_checklist_bypassed: process.env.NODE_ENV === 'development',
      items,
      events,
      pending_deliveries,
      delivery_exceptions,
      shifts,
    };
  }

  private async lockReport(
    transaction: Transaction<DB>,
    branchId: string,
    reportId: string,
    lockOfflineWriters = false,
  ) {
    await lockReceivingBranch(transaction, branchId);
    if (lockOfflineWriters) {
      // Offline preparation/sync holds FOR SHARE on this row before shift/session
      // locks. Acquire the exclusive lock before reading the report or sessions;
      // keep the receiving advisory lock first to match receiving workflows.
      const branch = await transaction
        .selectFrom('branches')
        .select('id')
        .where('id', '=', branchId)
        .forUpdate()
        .executeTakeFirst();
      if (!branch) throw new NotFoundException('Branch not found');
    }
    const report = await transaction
      .selectFrom('daily_branch_reports')
      .select([
        'id',
        'status',
        'return_reason',
        sql<string>`business_date::text`.as('business_date'),
      ])
      .where('id', '=', reportId)
      .where('branch_id', '=', branchId)
      .forUpdate()
      .executeTakeFirst();
    if (!report) throw new NotFoundException('Daily report not found');
    return report;
  }

  private async requireBranch(executor: DbExecutor, branchId: string) {
    const branch = await executor
      .selectFrom('branches')
      .select('id')
      .where('id', '=', branchId)
      .executeTakeFirst();
    if (!branch) throw new NotFoundException('Branch not found');
  }

  private async requireActiveBranch(
    executor: DbExecutor,
    branchId: string,
    allowInactive = false,
  ) {
    const branch = await executor
      .selectFrom('branches')
      .select(['id', 'status'])
      .where('id', '=', branchId)
      .forShare()
      .executeTakeFirst();
    if (!branch || (branch.status !== 'active' && !allowInactive))
      throw new ConflictException('The branch is inactive');
  }

  private async manilaToday(executor: DbExecutor) {
    return sql<{ today: string }>`
      SELECT coms_business_date(now())::text AS today
    `
      .execute(executor)
      .then((result) => result.rows[0]!);
  }

  private requireCompleteItemSet(
    existingItems: { stock_item_id: string }[],
    entries: ReportEntry[],
  ) {
    const expected = new Set(existingItems.map((item) => item.stock_item_id));
    if (
      entries.length !== expected.size ||
      new Set(entries.map((item) => item.stock_item_id)).size !==
        entries.length ||
      entries.some((item) => !expected.has(item.stock_item_id))
    )
      throw new BadRequestException(
        'Updates must include exactly one count for every report stock item',
      );
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    );
  }
}
