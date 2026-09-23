import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { AccessContext } from '../access-control/access-control.types';
import type { CloseDispatchShortageDto } from './dto/close-dispatch-shortage.dto';
import type { CreateDispatchDto } from './dto/create-dispatch.dto';
import type { DispatchQueryDto } from './dto/dispatch-query.dto';
import type { ReceiveDispatchDto } from './dto/receive-dispatch.dto';
import { DispatchDraftsRepository } from './dispatch-drafts.repository';
import { DispatchPostingRepository } from './dispatch-posting.repository';
import { DispatchReceivingRepository } from './dispatch-receiving.repository';
import { DispatchesRepository } from './dispatches.repository';

const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

@Injectable()
export class DispatchesService {
  constructor(
    private readonly repository: DispatchesRepository,
    private readonly draftsRepository: DispatchDraftsRepository,
    private readonly postingRepository: DispatchPostingRepository,
    private readonly receivingRepository: DispatchReceivingRepository,
  ) {}

  list(query: DispatchQueryDto, access: AccessContext) {
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
    const dispatch = await this.repository.findById(id);
    if (!dispatch || !this.canAccessBranch(dispatch.branch_id, access))
      throw new NotFoundException('Dispatch not found');
    return dispatch;
  }

  async create(
    input: CreateDispatchDto,
    access: AccessContext,
    idempotencyKey: string | undefined,
  ) {
    const key = this.requireIdempotencyKey(idempotencyKey);
    const stockRequest = await this.repository.findRequestForDispatch(
      input.stock_request_id,
    );
    if (!stockRequest) throw new NotFoundException('Stock request not found');
    if (!this.canAccessBranch(stockRequest.branch_id, access))
      throw new ForbiddenException('Branch access required');
    if (stockRequest.status !== 'APPROVED')
      throw new ConflictException(
        'Only approved stock requests can be dispatched',
      );
    return this.draftsRepository.createDraft({
      stock_request_id: input.stock_request_id,
      created_by_user_id: access.userId,
      idempotency_key: key,
    });
  }

  dispatch(
    id: string,
    access: AccessContext,
    idempotencyKey: string | undefined,
  ) {
    return this.postingRepository.dispatch({
      id,
      actor_user_id: access.userId,
      idempotency_key: this.requireIdempotencyKey(idempotencyKey),
      branch_ids: this.branchScope(access),
    });
  }

  receive(
    id: string,
    input: ReceiveDispatchDto,
    access: AccessContext,
    idempotencyKey: string | undefined,
  ) {
    const items = this.normalizeItems(
      input.items,
      'quantity_received',
      'Received quantity',
    );
    return this.receivingRepository.receive({
      id,
      actor_user_id: access.userId,
      idempotency_key: this.requireIdempotencyKey(idempotencyKey),
      branch_ids: this.branchScope(access),
      items,
    });
  }

  closeShortage(
    id: string,
    input: CloseDispatchShortageDto,
    access: AccessContext,
    idempotencyKey: string | undefined,
  ) {
    const reason = input.reason.trim();
    if (!reason || reason.length > 500)
      throw new BadRequestException(
        'A shortage reason is required and must not exceed 500 characters',
      );
    const items = this.normalizeItems(
      input.items,
      'quantity_closed',
      'Closed shortage quantity',
    );
    return this.receivingRepository.closeShortage({
      id,
      actor_user_id: access.userId,
      idempotency_key: this.requireIdempotencyKey(idempotencyKey),
      branch_ids: this.branchScope(access),
      reason,
      items,
    });
  }

  private normalizeItems(
    items: Array<{
      dispatch_item_id: string;
      quantity_received?: string;
      quantity_closed?: string;
    }>,
    field: 'quantity_received' | 'quantity_closed',
    label: string,
  ) {
    if (!Array.isArray(items) || items.length < 1 || items.length > 100)
      throw new BadRequestException(
        'An action must contain between 1 and 100 item lines',
      );
    const seen = new Set<string>();
    return items.map((item) => {
      if (seen.has(item.dispatch_item_id))
        throw new BadRequestException(
          'A dispatch item may appear only once per action',
        );
      seen.add(item.dispatch_item_id);
      const value = item[field];
      if (
        typeof value !== 'string' ||
        value.length > 80 ||
        !DECIMAL_PATTERN.test(value)
      )
        throw new BadRequestException(`${label} must be a decimal string`);
      const [wholePart, fractionPart = ''] = value.split('.');
      const whole = wholePart.replace(/^0+(?=\d)/, '');
      const fraction = fractionPart.replace(/0+$/, '');
      if (whole === '0' && fraction.length === 0)
        throw new BadRequestException(`${label} must be greater than zero`);
      return {
        dispatch_item_id: item.dispatch_item_id,
        quantity: `${whole}${fraction ? `.${fraction}` : ''}`,
      };
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
