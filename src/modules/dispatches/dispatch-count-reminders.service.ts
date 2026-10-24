import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { AccessContext } from '../access-control/access-control.types';
import { DispatchCountRemindersRepository } from './dispatch-count-reminders.repository';

@Injectable()
export class DispatchCountRemindersService {
  constructor(private readonly repository: DispatchCountRemindersRepository) {}
  send(id: string, access: AccessContext, key: string | undefined) {
    const admin = access.role?.isSystem && access.role.code === 'SUPER_ADMIN';
    if (
      !admin &&
      (!access.permissions.includes('dispatches.read') ||
        !access.permissions.includes('dispatches.dispatch'))
    )
      throw new ForbiddenException(
        'Dispatch reading and sending permissions are required',
      );
    if (!key || !isUUID(key))
      throw new BadRequestException('A valid Idempotency-Key is required');
    return this.repository.send({
      id,
      actor_user_id: access.userId,
      branch_ids: admin ? null : access.branchIds,
      idempotency_key: key,
    });
  }
}
