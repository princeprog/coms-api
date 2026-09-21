import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class AuthOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const origin = request.headers.origin;
    const allowedOrigin = process.env.WEB_ORIGIN?.trim();

    if (origin && allowedOrigin && origin !== allowedOrigin) {
      throw new ForbiddenException('Origin is not allowed');
    }

    return true;
  }
}
