import { BadRequestException, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { CreateDailyReportDto } from './dto/create-daily-report.dto';
import { DailyReportQueryDto } from './dto/daily-report-query.dto';
import { ReturnDailyReportDto } from './dto/return-daily-report.dto';
import { UpdateDailyReportDto } from './dto/update-daily-report.dto';
import { DailyReportsRepository } from './daily-reports.repository';

const NONNEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

@Injectable()
export class DailyReportsService {
  constructor(private readonly repository: DailyReportsRepository) {}

  list(branchId: string, query: DailyReportQueryDto) {
    return this.repository.list(branchId, query);
  }

  get(branchId: string, reportId: string) {
    return this.repository.find(branchId, reportId);
  }

  create(
    branchId: string,
    input: CreateDailyReportDto,
    actorUserId: string,
    idempotencyKey: string | undefined,
  ) {
    this.validateBusinessDate(input.business_date);
    const key = idempotencyKey?.trim();
    if (!key || !isUUID(key))
      throw new BadRequestException(
        'A valid Idempotency-Key header is required',
      );
    return this.repository.create(
      branchId,
      input.business_date,
      key,
      actorUserId,
    );
  }

  update(
    branchId: string,
    reportId: string,
    input: UpdateDailyReportDto,
    actorUserId: string,
  ) {
    const entries = input.items.map((item) => {
      const physical = this.normalizeDecimal(
        item.physical_closing_quantity,
        false,
        'Physical closing quantities',
      );
      const waste = this.normalizeDecimal(
        item.waste_quantity,
        false,
        'Waste quantities',
      );
      const adjustment = this.normalizeDecimal(
        item.adjustment_quantity,
        true,
        'Adjustment quantities',
      );
      return {
        stock_item_id: item.stock_item_id,
        physical_closing_quantity: physical,
        waste_quantity: waste,
        waste_reason: this.reasonForQuantity(waste, item.waste_reason, 'Waste'),
        adjustment_quantity: adjustment,
        adjustment_reason: this.reasonForQuantity(
          adjustment,
          item.adjustment_reason,
          'Adjustments',
        ),
      };
    });
    return this.repository.update(branchId, reportId, entries, actorUserId);
  }

  submit(branchId: string, reportId: string, actorUserId: string) {
    return this.repository.submit(branchId, reportId, actorUserId);
  }

  returnForCorrection(
    branchId: string,
    reportId: string,
    input: ReturnDailyReportDto,
    actorUserId: string,
  ) {
    const reason = input.reason.trim();
    if (!reason || reason.length > 500)
      throw new BadRequestException('A return reason is required');
    return this.repository.returnForCorrection(
      branchId,
      reportId,
      reason,
      actorUserId,
    );
  }

  approve(branchId: string, reportId: string, actorUserId: string) {
    return this.repository.approve(branchId, reportId, actorUserId);
  }

  private validateBusinessDate(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new BadRequestException('Business date must use YYYY-MM-DD');
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value
    )
      throw new BadRequestException(
        'Business date is not a valid calendar day',
      );
  }

  private normalizeDecimal(
    value: string,
    signed: boolean,
    description: string,
  ) {
    const pattern = signed ? SIGNED_DECIMAL : NONNEGATIVE_DECIMAL;
    if (typeof value !== 'string' || value.length > 80 || !pattern.test(value))
      throw new BadRequestException(`${description} must be decimal strings`);
    const isNegative = value.startsWith('-');
    const unsigned = isNegative ? value.slice(1) : value;
    const [wholePart, fractionPart = ''] = unsigned.split('.');
    const whole = wholePart.replace(/^0+(?=\d)/, '');
    const fraction = fractionPart.replace(/0+$/, '');
    const isZero = whole === '0' && fraction.length === 0;
    const sign = isNegative && !isZero ? '-' : '';
    return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
  }

  private reasonForQuantity(
    quantity: string,
    value: string | undefined,
    field: string,
  ) {
    if (quantity === '0') return null;
    const reason = value?.trim();
    if (!reason || reason.length > 500)
      throw new BadRequestException(`${field} require a reason`);
    return reason;
  }
}
