import { BadRequestException, Injectable } from '@nestjs/common';
import { BusinessDayRepository } from './business-day.repository';
import type { UpdateBusinessDayDto } from './dto/update-business-day.dto';

@Injectable()
export class BusinessDayService {
  constructor(private readonly repository: BusinessDayRepository) {}

  settings() {
    return this.repository.settings();
  }

  schedule(input: UpdateBusinessDayDto, actorUserId: string) {
    const parsed = new Date(`${input.effective_from}T00:00:00.000Z`);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== input.effective_from
    )
      throw new BadRequestException(
        'Effective date is not a valid calendar day',
      );
    return this.repository.schedule(
      input.start_time,
      input.effective_from,
      actorUserId,
    );
  }

  cancelScheduled() {
    return this.repository.cancelScheduled();
  }
}
