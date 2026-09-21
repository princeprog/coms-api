import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
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
import { getAuthConfig } from '../../config/auth.config';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthService, type PublicUser } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly rateLimiter: AuthRateLimitService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AuthOriginGuard)
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.register(dto);
    this.setAuthCookies(response, result.tokens);
    return { user: result.user };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthOriginGuard)
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.rateLimiter.assertAllowed('login', this.clientKey(request));
    const result = await this.authService.login(dto);
    this.setAuthCookies(response, result.tokens);
    return { user: result.user };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthOriginGuard)
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.rateLimiter.assertAllowed('refresh', this.clientKey(request));
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
    response.clearCookie(ACCESS_COOKIE, { path: '/' });
    response.clearCookie(REFRESH_COOKIE, { path: '/' });
    response.header('Cache-Control', 'no-store');
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(
    @CurrentUser() user: PublicUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.header('Cache-Control', 'no-store');
    return { user };
  }

  private setAuthCookies(
    response: Response,
    tokens: { accessToken: string; refreshToken: string },
  ): void {
    const config = getAuthConfig();
    response.header('Cache-Control', 'no-store');
    response.cookie(ACCESS_COOKIE, tokens.accessToken, {
      ...TOKEN_COOKIE_OPTIONS,
      maxAge: config.accessTtlSeconds * 1000,
    });
    response.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...TOKEN_COOKIE_OPTIONS,
      maxAge: config.refreshTtlSeconds * 1000,
    });
  }

  private clientKey(request: Request): string {
    return request.ip ?? request.socket.remoteAddress ?? 'unknown';
  }
}
