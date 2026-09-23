import { HttpException, Injectable } from '@nestjs/common';
import { getAuthConfig } from '../../config/auth.config';
import { recordAuthEvent } from '../../common/utils/auth-events';
import {
  AuthRateLimitRepository,
  type RateDecision,
} from './auth-rate-limit.repository';

export class AuthRateLimitException extends HttpException {
  constructor(public readonly retryAfterSeconds: number) {
    super(
      { message: 'Too many authentication attempts', retryAfterSeconds },
      429,
    );
    recordAuthEvent('rate_limited', 429);
  }
}
@Injectable()
export class AuthRateLimitService {
  constructor(private readonly repository: AuthRateLimitRepository) {}
  async capacity(): Promise<void> {
    const decision = await this.repository.consume(
      'capacity',
      'coms-auth',
      getAuthConfig().capacityLimit,
    );
    this.assert(decision);
    await this.repository.cleanup();
  }
  async login(email: string): Promise<void> {
    this.assert(
      await this.repository.consume(
        'login',
        email.trim().toLowerCase(),
        getAuthConfig().loginLimit,
      ),
    );
  }
  private assert(decision: RateDecision): void {
    if (!decision.allowed)
      throw new AuthRateLimitException(decision.retryAfterSeconds);
  }
}
