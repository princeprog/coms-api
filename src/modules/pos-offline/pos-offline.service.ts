import { ConflictException, Injectable } from '@nestjs/common';
import { offlinePosEnabled } from '../../config/offline-pos.config';
import { PosOfflineRepository } from './pos-offline.repository';
import type { SyncOfflineDto } from './dto/offline-register.dto';

@Injectable()
export class PosOfflineService {
  constructor(private readonly repository: PosOfflineRepository) {}
  prepare(branchId: string, userId: string, deviceId: string) {
    if (!offlinePosEnabled())
      throw new ConflictException(
        'Offline checkout is not enabled for this installation yet.',
      );
    return this.repository.prepare(branchId, userId, deviceId);
  }
  async sync(
    branchId: string,
    userId: string,
    sessionId: string,
    input: SyncOfflineDto,
    recoveryReason?: string,
  ) {
    const results = [];
    // Each acknowledgement has its own commit. A transport failure cannot undo a
    // previous item, and replaying the batch returns the same stored results.
    for (const envelope of input.transactions)
      results.push(
        await this.repository.ingest(
          branchId,
          userId,
          sessionId,
          input.device_id,
          envelope,
          recoveryReason,
        ),
      );
    return { results };
  }
}
