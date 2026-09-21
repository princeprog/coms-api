import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

type Bucket = { count: number; resetAt: number };

@Injectable()
export class AuthRateLimitService {
  private readonly buckets = new Map<string, Bucket>();

  assertAllowed(scope: 'login' | 'refresh', key: string): void {
    const limit = scope === 'login' ? 10 : 20;
    const now = Date.now();
    const bucketKey = `${scope}:${key}`;
    const current = this.buckets.get(bucketKey);
    if (!current || current.resetAt <= now) {
      this.buckets.set(bucketKey, { count: 1, resetAt: now + 60_000 });
      return;
    }
    current.count += 1;
    if (current.count > limit) {
      throw new HttpException(
        'Too many authentication attempts',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
