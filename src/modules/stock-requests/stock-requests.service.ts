import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { AccessContext } from '../access-control/access-control.types';
import type { CreateStockRequestDto } from './dto/create-stock-request.dto';
import type { StockRequestQueryDto } from './dto/stock-request-query.dto';
import { StockRequestsRepository } from './stock-requests.repository';

const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

@Injectable()
export class StockRequestsService {
  constructor(private readonly repository: StockRequestsRepository) {}

  list(query: StockRequestQueryDto, access: AccessContext) {
    const branchIds = this.branchScope(access);
    if (query.branch_id && branchIds && !branchIds.includes(query.branch_id))
      throw new ForbiddenException('Branch access required');

    if (branchIds && branchIds.length === 0)
      return Promise.resolve({
        items: [],
        total: 0,
        page: query.page,
        page_size: query.page_size,
      });

    return this.repository.list(query, branchIds);
  }

  async get(id: string, access: AccessContext) {
    const stockRequest = await this.repository.findById(id);
    if (!stockRequest || !this.canAccessBranch(stockRequest.branch_id, access))
      throw new NotFoundException('Stock request not found');
    return stockRequest;
  }

  async create(
    input: CreateStockRequestDto,
    access: AccessContext,
    idempotencyKey: string | undefined,
  ) {
    const key = idempotencyKey?.trim();
    if (!key || !isUUID(key))
      throw new BadRequestException(
        'A valid Idempotency-Key header is required',
      );

    if (!this.canAccessBranch(input.branch_id, access))
      throw new ForbiddenException('Branch access required');
    if (input.items.length < 1 || input.items.length > 100)
      throw new BadRequestException(
        'A stock request must contain between 1 and 100 items',
      );

    const itemIds = new Set<string>();
    const items = input.items.map((item) => {
      if (itemIds.has(item.stock_item_id))
        throw new BadRequestException(
          'A stock item may appear only once in a request',
        );
      itemIds.add(item.stock_item_id);
      return {
        stock_item_id: item.stock_item_id,
        quantity_requested: this.normalizeQuantity(item.quantity_requested),
      };
    });

    return this.repository.create({
      branch_id: input.branch_id,
      requested_by_user_id: access.userId,
      idempotency_key: key,
      items,
    });
  }

  approve(id: string, access: AccessContext) {
    return this.repository.transition(
      id,
      'APPROVED',
      access.userId,
      this.branchScope(access),
    );
  }

  reject(id: string, access: AccessContext) {
    return this.repository.transition(
      id,
      'REJECTED',
      access.userId,
      this.branchScope(access),
    );
  }

  cancel(id: string, access: AccessContext) {
    return this.repository.transition(
      id,
      'CANCELLED',
      access.userId,
      this.branchScope(access),
      true,
    );
  }

  private normalizeQuantity(value: string): string {
    if (
      typeof value !== 'string' ||
      value.length > 80 ||
      !DECIMAL_PATTERN.test(value)
    )
      throw new BadRequestException(
        'Requested quantities must be decimal strings',
      );

    const [wholePart, fractionPart = ''] = value.split('.');
    const whole = wholePart.replace(/^0+(?=\d)/, '');
    const fraction = fractionPart.replace(/0+$/, '');
    if (whole === '0' && fraction.length === 0)
      throw new BadRequestException(
        'Requested quantity must be greater than zero',
      );

    return `${whole}${fraction ? `.${fraction}` : ''}`;
  }

  private branchScope(access: AccessContext): string[] | null {
    return this.isSuperAdmin(access) ? null : access.branchIds;
  }

  private canAccessBranch(branchId: string, access: AccessContext): boolean {
    return this.isSuperAdmin(access) || access.branchIds.includes(branchId);
  }

  private isSuperAdmin(access: AccessContext): boolean {
    return access.role.isSystem && access.role.code === 'SUPER_ADMIN';
  }
}
