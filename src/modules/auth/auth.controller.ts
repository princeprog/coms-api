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
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from '../../common/constants/auth.constants';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AuthService, type PublicUser } from './auth.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.register(dto);

    response.header('Cache-Control', 'no-store');
    response.cookie(SESSION_COOKIE, result.token, SESSION_COOKIE_OPTIONS);

    return {
      user: result.user,
    };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.login(dto);

    response.header('Cache-Control', 'no-store');
    response.cookie(SESSION_COOKIE, result.token, SESSION_COOKIE_OPTIONS);

    return {
      user: result.user,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.authService.logout(request.cookies?.[SESSION_COOKIE]);

    response.clearCookie(SESSION_COOKIE, { path: '/' });
    response.header('Cache-Control', 'no-store');
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: PublicUser) {
    return { user };
  }
}
