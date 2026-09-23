import { CanActivate, Injectable } from '@nestjs/common';
import { AuthRateLimitService } from '../../modules/auth/auth-rate-limit.service';

@Injectable()
export class AuthCapacityGuard implements CanActivate {
  constructor(private readonly rateLimits: AuthRateLimitService) {}
  async canActivate(): Promise<boolean> {
    await this.rateLimits.capacity();
    return true;
  }
}
