import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  TOKEN_COOKIE_OPTIONS,
} from '../../common/constants/auth.constants';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AuthOriginGuard } from '../../common/guards/auth-origin.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthCapacityGuard } from '../../common/guards/auth-capacity.guard';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import { AuthExceptionFilter } from '../../common/filters/auth-exception.filter';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthService, type PublicUser, type TokenPair } from './auth.service';

import { LoginDto } from './dto/login.dto';
import type { AccessContext } from '../access-control/access-control.types';

@Controller('auth')
@UseGuards(AuthGatewayGuard)
@UseFilters(AuthExceptionFilter)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly rateLimiter: AuthRateLimitService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthOriginGuard, AuthCapacityGuard)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.rateLimiter.login(dto.email);
    const result = await this.authService.login(dto);
    this.setAuthCookies(response, result.tokens);
    return { user: result.user };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthOriginGuard, AuthCapacityGuard)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.refresh(
      request.cookies?.[REFRESH_COOKIE],
    );
    this.setAuthCookies(response, result.tokens);
    return { user: result.user };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthOriginGuard)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.authService.logout(
      request.cookies?.[ACCESS_COOKIE],
      request.cookies?.[REFRESH_COOKIE],
    );
    for (const name of [ACCESS_COOKIE, REFRESH_COOKIE]) {
      response.cookie(name, '', {
        ...TOKEN_COOKIE_OPTIONS,
        maxAge: 0,
        expires: new Date(0),
      });
    }
    response.header('Cache-Control', 'no-store');
  }

  @Get('me')
  @UseGuards(AuthGuard, AccessControlGuard)
  me(
    @CurrentUser() user: PublicUser,
    @CurrentAccessContext() access: AccessContext,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.header('Cache-Control', 'no-store');
    return {
      user,
      role: access.role,
      permissions: access.permissions,
      branch_ids: access.branchIds,
    };
  }

  private setAuthCookies(response: Response, tokens: TokenPair): void {
    response.header('Cache-Control', 'no-store');
    response.cookie(ACCESS_COOKIE, tokens.accessToken, {
      ...TOKEN_COOKIE_OPTIONS,
      expires: tokens.accessExpiresAt,
    });
    response.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...TOKEN_COOKIE_OPTIONS,
      expires: tokens.refreshExpiresAt,
    });
  }
}
