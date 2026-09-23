import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { InventoryMovementQueryDto } from './dto/inventory-movement-query.dto';
import { InventoryQueryDto } from './dto/inventory-query.dto';
import { CreateInventoryAdjustmentDto } from './dto/create-inventory-adjustment.dto';
import { InventoryRepository } from './inventory.repository';

const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export type InventoryScope = 'COMMISSARY' | 'BRANCH';

@Injectable()
export class InventoryService {
  constructor(private readonly repository: InventoryRepository) {}

  listCommissary(query: InventoryQueryDto) {
    return this.repository.listCommissary(query);
  }

  async listBranch(branchId: string, query: InventoryQueryDto) {
    await this.requireBranch(branchId);
    return this.repository.listBranch(branchId, query);
  }

  listCommissaryMovements(query: InventoryMovementQueryDto) {
    return this.repository.listMovements('COMMISSARY', null, query);
  }

  async listBranchMovements(
    branchId: string,
    query: InventoryMovementQueryDto,
  ) {
    await this.requireBranch(branchId);
    return this.repository.listMovements('BRANCH', branchId, query);
  }

  adjustCommissary(
    input: CreateInventoryAdjustmentDto,
    actorUserId: string,
    idempotencyKey: string | undefined,
  ) {
    return this.adjust(input, actorUserId, idempotencyKey, 'COMMISSARY', null);
  }

  adjustBranch(
    branchId: string,
    input: CreateInventoryAdjustmentDto,
    actorUserId: string,
    idempotencyKey: string | undefined,
  ) {
    return this.adjust(input, actorUserId, idempotencyKey, 'BRANCH', branchId);
  }

  private adjust(
    input: CreateInventoryAdjustmentDto,
    actorUserId: string,
    idempotencyKey: string | undefined,
    scope: InventoryScope,
    branchId: string | null,
  ) {
    const quantityDelta = this.normalizeNonzeroDecimal(input.quantity_delta);
    const reason = input.reason.trim();
    const normalizedIdempotencyKey = idempotencyKey?.trim();

    if (!normalizedIdempotencyKey || !isUUID(normalizedIdempotencyKey))
      throw new BadRequestException(
        'A valid Idempotency-Key header is required',
      );
    if (reason.length < 1 || reason.length > 500)
      throw new BadRequestException(
        'Adjustment reason is required and must not exceed 500 characters',
      );

    return this.repository.postAdjustment({
      scope,
      branchId,
      stockItemId: input.stock_item_id,
      quantityDelta,
      reason,
      actorUserId,
      idempotencyKey: normalizedIdempotencyKey,
    });
  }

  private normalizeNonzeroDecimal(value: string): string {
    if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value))
      throw new BadRequestException('Quantity delta must be a decimal string');

    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [wholePart, fractionPart = ''] = unsigned.split('.');
    const whole = wholePart.replace(/^0+(?=\d)/, '');
    const fraction = fractionPart.replace(/0+$/, '');
    const isZero = whole === '0' && fraction.length === 0;
    if (isZero) throw new BadRequestException('Quantity delta cannot be zero');

    return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
  }

  private async requireBranch(branchId: string): Promise<void> {
    if (!(await this.repository.branchExists(branchId)))
      throw new NotFoundException('Branch not found');
  }
}
