import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { ACCESS_COOKIE } from '../constants/auth.constants';
import { AuthService, type PublicUser } from '../../modules/auth/auth.service';

export type AuthenticatedRequest = Request & {
  user: PublicUser;
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const token = request.cookies?.[ACCESS_COOKIE];
    const user = await this.authService.authenticateAccess(token);

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    request.user = user;

    return true;
  }
}
