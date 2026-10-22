import { BadRequestException, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { AccessContext } from '../access-control/access-control.types';
import type {
  CashMovementDto,
  CloseShiftDto,
  ForceCloseShiftDto,
  OpenShiftDto,
  ReviewShiftDto,
  ShiftExplanationDto,
  ShiftQueryDto,
} from './dto/shift.dto';
import { ShiftsRepository } from './shifts.repository';

type ShiftDetail = Awaited<ReturnType<ShiftsRepository['find']>>;

@Injectable()
export class ShiftsService {
  constructor(private readonly repository: ShiftsRepository) {}

  async current(branchId: string, access: AccessContext) {
    const shift = await this.repository.current(branchId);
    return { shift: shift ? this.visible(shift, access) : null };
  }

  async find(branchId: string, shiftId: string, access: AccessContext) {
    const shift = this.visible(
      await this.repository.find(branchId, shiftId),
      access,
    );
    // Sales figures would reveal expected cash during a cashier's blind count.
    if (shift.cash_hidden)
      return { ...shift, sales_summary: null, products: [] };
    return {
      ...shift,
      ...(await this.repository.salesReport(branchId, shiftId)),
    };
  }

  async mine(access: AccessContext) {
    const shift = await this.repository.currentForUser(
      access.userId,
      isSuperAdmin(access) ? null : access.branchIds,
    );
    return { shift: shift ? this.visible(shift, access) : null };
  }

  list(branchId: string, query: ShiftQueryDto) {
    if (query.date_from && query.date_to && query.date_from > query.date_to)
      throw new BadRequestException('Start date must be on or before end date');
    return this.repository.list(branchId, query);
  }

  async open(
    branchId: string,
    input: OpenShiftDto,
    access: AccessContext,
    key?: string,
  ) {
    const shift = await this.repository.open({
      branchId,
      actorUserId: access.userId,
      openingFloat: input.opening_float,
      idempotencyKey: this.key(key),
    });
    return this.visible(shift, access);
  }

  async addCashMovement(
    branchId: string,
    shiftId: string,
    input: CashMovementDto,
    access: AccessContext,
    key?: string,
  ) {
    const amount = input.amount;
    if (!/[1-9]/.test(amount))
      throw new BadRequestException('Enter an amount greater than zero');
    const shift = await this.repository.addCashMovement({
      branchId,
      shiftId,
      actorUserId: access.userId,
      canReview: canReview(access),
      direction: input.direction,
      amount,
      reason: this.text(input.reason, 'A reason is required'),
      idempotencyKey: this.key(key),
    });
    return this.visible(shift, access);
  }

  close(
    branchId: string,
    shiftId: string,
    input: CloseShiftDto,
    access: AccessContext,
    key?: string,
  ) {
    return this.repository.close({
      branchId,
      shiftId,
      actorUserId: access.userId,
      countedCash: input.counted_cash,
      leftInDrawer: input.left_in_drawer,
      idempotencyKey: this.key(key),
    });
  }

  forceClose(
    branchId: string,
    shiftId: string,
    input: ForceCloseShiftDto,
    access: AccessContext,
    key?: string,
  ) {
    return this.repository.close({
      branchId,
      shiftId,
      actorUserId: access.userId,
      countedCash: input.counted_cash,
      leftInDrawer: input.left_in_drawer,
      idempotencyKey: this.key(key),
      forceReason: this.text(input.reason, 'A force-close reason is required'),
    });
  }

  explain(
    branchId: string,
    shiftId: string,
    input: ShiftExplanationDto,
    access: AccessContext,
  ) {
    return this.repository.explain({
      branchId,
      shiftId,
      actorUserId: access.userId,
      explanation: this.text(input.explanation, 'Enter an explanation'),
    });
  }

  review(
    branchId: string,
    shiftId: string,
    input: ReviewShiftDto,
    access: AccessContext,
  ) {
    return this.repository.review({
      branchId,
      shiftId,
      actorUserId: access.userId,
      superAdmin: isSuperAdmin(access),
      note: input.note?.trim() || null,
    });
  }

  /** Blind count: cashiers never see expected cash while their shift is open. */
  private visible(shift: ShiftDetail, access: AccessContext) {
    if (shift.status !== 'OPEN' || canReview(access))
      return { ...shift, cash_hidden: false };
    return {
      ...shift,
      totals: {
        ...shift.totals,
        cash_sales_amount: null,
        cash_refunds_amount: null,
        expected_cash: null,
        non_cash_sales_amount: null,
      },
      payments: [],
      voids: shift.voids.map((entry) => ({ ...entry, amount: null })),
      cash_hidden: true,
    };
  }

  private key(value?: string) {
    const key = value?.trim();
    if (!key || !isUUID(key))
      throw new BadRequestException(
        'A valid Idempotency-Key header is required',
      );
    return key;
  }

  private text(value: string, message: string) {
    const trimmed = value.trim();
    if (!trimmed) throw new BadRequestException(message);
    return trimmed;
  }
}

function isSuperAdmin(access: AccessContext) {
  return Boolean(access.role?.isSystem && access.role.code === 'SUPER_ADMIN');
}

function canReview(access: AccessContext) {
  return isSuperAdmin(access) || access.permissions.includes('shifts.review');
}
