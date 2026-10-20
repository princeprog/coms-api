import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { ReceiptPostingRepository } from './receipt-posting.repository';
import { DirectPurchasesRepository } from './direct-purchases.repository';
import { isReceiptDate, normalizeReceiptDecimal } from './receipt-validation';
import type {
  CreateDirectPurchaseDto,
  DirectPurchaseQueryDto,
} from './dto/direct-purchase.dto';
@Injectable()
export class DirectPurchasesService {
  constructor(
    private readonly repository: DirectPurchasesRepository,
    private readonly posting: ReceiptPostingRepository,
  ) {}
  list(query: DirectPurchaseQueryDto) {
    if (
      [query.purchased_from, query.purchased_to].some(
        (date) => date && !isReceiptDate(date),
      ) ||
      (query.purchased_from &&
        query.purchased_to &&
        query.purchased_from > query.purchased_to)
    )
      throw new BadRequestException('Choose a valid purchase date range');
    return this.repository.list(query);
  }
  async get(id: string) {
    const receipt = await this.repository.findById(id);
    if (!receipt) throw new NotFoundException('Purchase not found');
    return { ...receipt, purchase_date: receipt.received_at };
  }
  async create(input: CreateDirectPurchaseDto, actor: string, key?: string) {
    if (!key || !isUUID(key))
      throw new BadRequestException(
        'A valid Idempotency-Key header is required',
      );
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    if (!isReceiptDate(input.purchase_date) || input.purchase_date > today)
      throw new BadRequestException(
        'Purchase date must be a valid date on or before today',
      );
    if (
      !input.items?.length ||
      input.items.length > 100 ||
      new Set(input.items.map((item) => item.stock_item_id)).size !==
        input.items.length
    )
      throw new BadRequestException('Choose 1 to 100 distinct stock items');
    const receipt = await this.posting.create({
      receipt_kind: 'DIRECT_PURCHASE',
      supplier_id: null,
      received_at: input.purchase_date,
      store_name: input.store_name?.trim() || null,
      receipt_number: input.receipt_number?.trim() || null,
      notes: input.notes?.trim() || null,
      recorded_by_user_id: actor,
      idempotency_key: key,
      items: input.items.map((item) => ({
        stock_item_id: item.stock_item_id,
        quantity_received: normalizeReceiptDecimal(
          item.quantity_received,
          true,
        ),
        unit_cost: normalizeReceiptDecimal(item.unit_cost, false),
      })),
    });
    return { ...receipt, purchase_date: receipt.received_at };
  }
}
