import { BadRequestException, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { CreateSaleDto } from './dto/create-sale.dto';
import { SaleQueryDto } from './dto/sale-query.dto';
import { VoidSaleDto } from './dto/void-sale.dto';
import { SalesRepository } from './sales.repository';

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

@Injectable()
export class SalesService {
  constructor(private readonly repository: SalesRepository) {}

  list(branchId: string, query: SaleQueryDto) {
    return this.repository.list(branchId, query);
  }

  get(branchId: string, saleId: string) {
    return this.repository.findById(branchId, saleId);
  }

  create(
    branchId: string,
    input: CreateSaleDto,
    actorUserId: string,
    idempotencyKey: string | undefined,
  ) {
    const key = this.requireIdempotencyKey(idempotencyKey);
    const tenderMethod = input.tender_method.trim();
    if (!tenderMethod || tenderMethod.length > 40)
      throw new BadRequestException('Tender method is required');

    const seen = new Set<string>();
    const items = input.items.map(({ product_id, quantity }) => {
      if (seen.has(product_id))
        throw new BadRequestException(
          'A product may appear only once in a sale',
        );
      seen.add(product_id);
      return {
        productId: product_id,
        quantity: this.normalizePositiveDecimal(quantity),
      };
    });

    return this.repository.create({
      branchId,
      actorUserId,
      tenderMethod,
      idempotencyKey: key,
      items,
    });
  }

  void(
    branchId: string,
    saleId: string,
    input: VoidSaleDto,
    actorUserId: string,
    idempotencyKey: string | undefined,
  ) {
    const key = this.requireIdempotencyKey(idempotencyKey);
    const reason = input.reason.trim();
    if (!reason || reason.length > 500)
      throw new BadRequestException('A void reason is required');

    return this.repository.void({
      branchId,
      saleId,
      actorUserId,
      idempotencyKey: key,
      reason,
    });
  }

  private requireIdempotencyKey(value: string | undefined): string {
    const key = value?.trim();
    if (!key || !isUUID(key))
      throw new BadRequestException(
        'A valid Idempotency-Key header is required',
      );
    return key;
  }

  private normalizePositiveDecimal(value: string): string {
    if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value))
      throw new BadRequestException('Sale quantities must be decimal strings');
    const [wholePart, fractionPart = ''] = value.split('.');
    const whole = wholePart.replace(/^0+(?=\d)/, '');
    const fraction = fractionPart.replace(/0+$/, '');
    if (whole === '0' && fraction.length === 0)
      throw new BadRequestException(
        'Sale quantities must be greater than zero',
      );
    return `${whole}${fraction ? `.${fraction}` : ''}`;
  }
}
