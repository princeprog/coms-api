import { BadRequestException } from '@nestjs/common';

export const AUTH_ISSUER = 'coms-api';
export const AUTH_AUDIENCE = 'coms-web';
export const ACCESS_TOKEN_TYPE = 'access';
export const REFRESH_TOKEN_TYPE = 'refresh';

export type AuthConfig = {
  accessSecret: string;
  refreshSecret: string;
  gatewaySecret: string;
  webOrigin: string;
  loginLimit: number;
  refreshLimit: number;
  capacityLimit: number;
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
  if (
    !value ||
    !/^[a-fA-F0-9]{64}$/.test(value) ||
    /^(.{1,16})\1+$/i.test(value) ||
    new Set(value.toLowerCase()).size < 8
  ) {
    throw new BadRequestException(
      `${name} must be 64 hexadecimal characters without obvious repeated patterns`,
    );
  }

  return value.toLowerCase();
}

function positiveLimit(name: string, fallback: number): number {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (
    !/^[1-9]\d*$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value > 1_000_000
  ) {
    throw new BadRequestException(
      `${name} must be a positive integer at most 1000000`,
    );
  }
  return value;
}

export function getAuthConfig(): AuthConfig {
  const accessSecret = requiredSecret('JWT_ACCESS_SECRET');
  const refreshSecret = requiredSecret('JWT_REFRESH_SECRET');
  const gatewaySecret = requiredSecret('COMS_AUTH_GATEWAY_SECRET');

  if (new Set([accessSecret, refreshSecret, gatewaySecret]).size !== 3) {
    throw new BadRequestException(
      'Access, refresh, and gateway secrets must be different',
    );
  }

  const accessExpiresIn = process.env.JWT_ACCESS_EXPIRES_IN?.trim() ?? '';
  const webOrigin = process.env.WEB_ORIGIN ?? '';
  try {
    const url = new URL(webOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== webOrigin)
      throw new Error();
  } catch {
    throw new BadRequestException(
      'WEB_ORIGIN must be an exact http(s) origin without a path',
    );
  }
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
    gatewaySecret,
    webOrigin,
    loginLimit: positiveLimit('AUTH_LOGIN_LIMIT_PER_MINUTE', 10),
    refreshLimit: positiveLimit('AUTH_REFRESH_LIMIT_PER_MINUTE', 20),
    capacityLimit: positiveLimit('AUTH_CAPACITY_LIMIT_PER_MINUTE', 600),
    accessExpiresIn,
    refreshExpiresIn,
    accessTtlSeconds,
    refreshTtlSeconds,
    issuer: process.env.JWT_ISSUER?.trim() || AUTH_ISSUER,
    audience: process.env.JWT_AUDIENCE?.trim() || AUTH_AUDIENCE,
  };
}
