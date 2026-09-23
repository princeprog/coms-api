import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { getAuthConfig } from '../../config/auth.config';
import { recordAuthEvent } from '../utils/auth-events';

@Injectable()
export class AuthOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const origin = request.headers.origin;
    const allowedOrigin = getAuthConfig().webOrigin;

    if (origin !== allowedOrigin) {
      recordAuthEvent('origin_rejected', 403);
      throw new ForbiddenException('Origin is not allowed');
    }

    return true;
  }
}
