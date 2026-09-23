import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { getAuthConfig } from '../../config/auth.config';
import { recordAuthEvent } from '../utils/auth-events';

@Injectable()
export class AuthGatewayGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const supplied = context.switchToHttp().getRequest<Request>().headers[
      'x-coms-auth-gateway'
    ];
    const expected = Buffer.from(getAuthConfig().gatewaySecret);
    const actual = Buffer.from(typeof supplied === 'string' ? supplied : '');
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      recordAuthEvent('gateway_rejected', 403);
      throw new ForbiddenException('Authentication gateway required');
    }
    return true;
  }
}
