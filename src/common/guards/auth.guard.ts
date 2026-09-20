import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { SESSION_COOKIE } from '../constants/auth.constants';
import { AuthService, type PublicUser } from '../../modules/auth/auth.service';

export type AuthenticatedRequest = Request & {
  user: PublicUser;
  sessionId: string;
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const token = request.cookies?.[SESSION_COOKIE];
    const session = await this.authService.authenticateSession(token);

    if (!session) {
      throw new UnauthorizedException('Authentication required');
    }

    request.user = session.user;
    request.sessionId = session.sessionId;

    return true;
  }
}
