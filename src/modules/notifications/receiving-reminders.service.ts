import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ReceivingRemindersRepository } from './receiving-reminders.repository';

@Injectable()
export class ReceivingRemindersService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ReceivingRemindersService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(private readonly repository: ReceivingRemindersRepository) {}
  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.sweep(), 60_000);
    this.timer.unref();
    void this.sweep();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async sweep() {
    if (this.running) return;
    this.running = true;
    try {
      const sent = await this.repository.sweep();
      this.logger.log(
        `Receiving reminders: ${sent} branch summaries published`,
      );
    } catch (error) {
      this.logger.error(
        'Receiving reminder sweep failed; will retry next minute',
        error instanceof Error ? error.message : 'Unknown error',
      );
    } finally {
      this.running = false;
    }
  }
}
