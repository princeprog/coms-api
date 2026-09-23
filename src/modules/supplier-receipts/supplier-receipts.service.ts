import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { CreateSupplierReceiptDto } from './dto/create-supplier-receipt.dto';
import type { SupplierReceiptQueryDto } from './dto/supplier-receipt-query.dto';
import { SupplierReceiptsRepository } from './supplier-receipts.repository';

const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

@Injectable()
export class SupplierReceiptsService {
  constructor(private readonly repository: SupplierReceiptsRepository) {}

  list(query: SupplierReceiptQueryDto) {
    const search = query.search?.trim();
    return this.repository.list({
      page: query.page,
      page_size: query.page_size,
      ...(search ? { search } : {}),
      ...(query.supplier_id ? { supplier_id: query.supplier_id } : {}),
      ...(query.status ? { status: query.status } : {}),
    });
  }

  async get(id: string) {
    const receipt = await this.repository.findById(id);
    if (!receipt) throw new NotFoundException('Supplier receipt not found');
    return receipt;
  }

  async create(
    input: CreateSupplierReceiptDto,
    actorUserId: string,
    idempotencyKey: string | undefined,
  ) {
    const key = idempotencyKey?.trim();
    if (!key || !isUUID(key))
      throw new BadRequestException(
        'A valid Idempotency-Key header is required',
      );

    if (!this.isDateOnly(input.received_at))
      throw new BadRequestException(
        'Received date must be a valid YYYY-MM-DD date',
      );

    if (
      !Array.isArray(input.items) ||
      input.items.length < 1 ||
      input.items.length > 100
    )
      throw new BadRequestException(
        'A receipt must contain between 1 and 100 items',
      );

    const items = input.items.map((item) => ({
      stock_item_id: item.stock_item_id,
      quantity_received: this.normalizeDecimal(item.quantity_received, true),
      unit_cost: this.normalizeDecimal(item.unit_cost, false),
    }));

    return this.repository.create({
      supplier_id: input.supplier_id,
      received_at: input.received_at,
      items,
      created_by_user_id: actorUserId,
      idempotency_key: key,
    });
  }

  post(id: string, actorUserId: string) {
    return this.repository.post(id, actorUserId);
  }

  private normalizeDecimal(value: string, mustBePositive: boolean): string {
    if (
      typeof value !== 'string' ||
      value.length > 80 ||
      !DECIMAL_PATTERN.test(value)
    )
      throw new BadRequestException(
        'Receipt quantities and costs must be decimal strings',
      );

    const [wholePart, fractionPart = ''] = value.split('.');
    const whole = wholePart.replace(/^0+(?=\d)/, '');
    const fraction = fractionPart.replace(/0+$/, '');
    const isZero = whole === '0' && fraction.length === 0;
    if (mustBePositive && isZero)
      throw new BadRequestException(
        'Received quantity must be greater than zero',
      );

    return `${whole}${fraction ? `.${fraction}` : ''}`;
  }

  private isDateOnly(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31)
      return false;

    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }
}
