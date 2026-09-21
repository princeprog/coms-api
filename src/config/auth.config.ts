import { BadRequestException } from '@nestjs/common';

export const AUTH_ISSUER = 'coms-api';
export const AUTH_AUDIENCE = 'coms-web';
export const ACCESS_TOKEN_TYPE = 'access';
export const REFRESH_TOKEN_TYPE = 'refresh';

export type AuthConfig = {
  accessSecret: string;
  refreshSecret: string;
  accessExpiresIn: string;
  refreshExpiresIn: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  issuer: string;
  audience: string;
};

function parseDuration(value: string, name: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) {
    throw new BadRequestException(
      `${name} must use a duration such as 15m or 30d`,
    );
  }

  const amount = Number(match[1]);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[
    match[2] as 's' | 'm' | 'h' | 'd'
  ];
  const seconds = amount * multiplier;

  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new BadRequestException(`${name} must be positive`);
  }

  return seconds;
}

function requiredSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || Buffer.byteLength(value, 'utf8') < 32) {
    throw new BadRequestException(`${name} must contain at least 32 bytes`);
  }

  return value;
}

export function getAuthConfig(): AuthConfig {
  const accessSecret = requiredSecret('JWT_ACCESS_SECRET');
  const refreshSecret = requiredSecret('JWT_REFRESH_SECRET');

  if (accessSecret === refreshSecret) {
    throw new BadRequestException(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different',
    );
  }

  const accessExpiresIn = process.env.JWT_ACCESS_EXPIRES_IN?.trim() ?? '';
  const refreshExpiresIn = process.env.JWT_REFRESH_EXPIRES_IN?.trim() ?? '';
  const accessTtlSeconds = parseDuration(
    accessExpiresIn,
    'JWT_ACCESS_EXPIRES_IN',
  );
  const refreshTtlSeconds = parseDuration(
    refreshExpiresIn,
    'JWT_REFRESH_EXPIRES_IN',
  );

  if (accessTtlSeconds >= refreshTtlSeconds) {
    throw new BadRequestException(
      'JWT_ACCESS_EXPIRES_IN must be shorter than JWT_REFRESH_EXPIRES_IN',
    );
  }

  return {
    accessSecret,
    refreshSecret,
    accessExpiresIn,
    refreshExpiresIn,
    accessTtlSeconds,
    refreshTtlSeconds,
    issuer: process.env.JWT_ISSUER?.trim() || AUTH_ISSUER,
    audience: process.env.JWT_AUDIENCE?.trim() || AUTH_AUDIENCE,
  };
}
