import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';
import { AuthRateLimitException } from '../../modules/auth/auth-rate-limit.service';
import { recordAuthEvent } from '../utils/auth-events';

@Catch()
export class AuthExceptionFilter extends BaseExceptionFilter {
  override catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    if (error instanceof AuthRateLimitException)
      response.setHeader('Retry-After', error.retryAfterSeconds);
    const status = error instanceof HttpException ? error.getStatus() : 503;
    if (status >= 500) {
      recordAuthEvent('auth_outage', status);
      response
        .status(status)
        .json({
          statusCode: status,
          message: 'Authentication service unavailable',
        });
      return;
    }
    super.catch(error, host);
  }
}
