import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { CreateSupplierReceiptDto } from './dto/create-supplier-receipt.dto';
import type { SupplierReceiptQueryDto } from './dto/supplier-receipt-query.dto';
import { SupplierReceiptsRepository } from './supplier-receipts.repository';

import { normalizeReceiptDecimal, isReceiptDate } from './receipt-validation';

@Injectable()
export class SupplierReceiptsService {
  constructor(private readonly repository: SupplierReceiptsRepository) {}

  list(query: SupplierReceiptQueryDto) {
    const search = query.search?.trim();
    for (const date of [query.received_from, query.received_to]) {
      if (date && !isReceiptDate(date))
        throw new BadRequestException(
          'Delivery dates must be valid YYYY-MM-DD dates',
        );
    }
    if (
      query.received_from &&
      query.received_to &&
      query.received_from > query.received_to
    )
      throw new BadRequestException(
        'Delivery start date must be on or before the end date',
      );
    if (query.min_cost && query.max_cost) {
      const [minWhole, minFraction = ''] = query.min_cost.split('.');
      const [maxWhole, maxFraction = ''] = query.max_cost.split('.');
      const scale = Math.max(minFraction.length, maxFraction.length);
      if (
        BigInt(minWhole + minFraction.padEnd(scale, '0')) >
        BigInt(maxWhole + maxFraction.padEnd(scale, '0'))
      )
        throw new BadRequestException(
          'Minimum cost must be less than or equal to maximum cost',
        );
    }
    return this.repository.list({
      page: query.page,
      page_size: query.page_size,
      ...(query.received_from ? { received_from: query.received_from } : {}),
      ...(query.received_to ? { received_to: query.received_to } : {}),
      ...(query.min_cost ? { min_cost: query.min_cost } : {}),
      ...(query.max_cost ? { max_cost: query.max_cost } : {}),
      ...(query.sort ? { sort: query.sort } : {}),
      ...(search ? { search } : {}),
      ...(query.supplier_id ? { supplier_id: query.supplier_id } : {}),
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

    if (!isReceiptDate(input.received_at))
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

    const stockItemIds = input.items.map((item) => item.stock_item_id);
    if (new Set(stockItemIds).size !== stockItemIds.length)
      throw new BadRequestException(
        'A stock item may appear only once in a supplier delivery',
      );

    const items = input.items.map((item) => ({
      stock_item_id: item.stock_item_id,
      quantity_received: normalizeReceiptDecimal(item.quantity_received, true),
      unit_cost: normalizeReceiptDecimal(item.unit_cost, false),
    }));

    return this.repository.create({
      supplier_id: input.supplier_id,
      received_at: input.received_at,
      items,
      recorded_by_user_id: actorUserId,
      idempotency_key: key,
    });
  }
}
