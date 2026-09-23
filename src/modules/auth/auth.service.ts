import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import type { Selectable, Transaction } from 'kysely';
import * as argon2 from 'argon2';
import type { AuthTokenFamilies, DB } from '../../database/db';
import {
  ACCESS_TOKEN_TYPE,
  getAuthConfig,
  REFRESH_TOKEN_TYPE,
} from '../../config/auth.config';
import { recordAuthEvent } from '../../common/utils/auth-events';
import type { LoginDto } from './dto/login.dto';
import { PASSWORD_HASH_OPTIONS } from './password-hashing';
import { AuthRepository } from './auth.repository';
import { AuthRateLimitRepository } from './auth-rate-limit.repository';
import { AuthRateLimitException } from './auth-rate-limit.service';

export type PublicUser = {
  id: string;
  email: string;
  full_name: string;
  contact_number: string;
};
export type TokenClaims = {
  sub: string;
  type: 'access' | 'refresh';
  familyId: string;
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
};
export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
};
export type AuthResult = { user: PublicUser; tokens: TokenPair };
type RefreshResult =
  | { kind: 'success'; result: AuthResult }
  | { kind: 'replay' | 'invalid' }
  | { kind: 'limited'; retryAfterSeconds: number };
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

@Injectable()
export class AuthService {
  private readonly dummyPasswordHashPromise = argon2.hash(
    'coms-dummy-password-value',
    PASSWORD_HASH_OPTIONS,
  );
  constructor(
    private readonly repository: AuthRepository,
    private readonly jwtService: JwtService,
    private readonly rateLimits: AuthRateLimitRepository,
  ) {}

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.repository.findByEmail(
      dto.email.trim().toLowerCase(),
    );
    const matches = await argon2.verify(
      user?.hashed_password ?? (await this.dummyPasswordHashPromise),
      dto.password,
    );
    if (!user || !matches || user.is_active === false)
      throw new UnauthorizedException('Invalid email or password');
    return this.repository.transaction(async (trx) => {
      const currentUser = await this.repository.findUserForSession(
        user.id,
        trx,
        true,
      );
      if (!currentUser?.is_active)
        throw new UnauthorizedException('Invalid email or password');
      const family = await this.repository.createFamily(
        trx,
        currentUser.id,
        getAuthConfig().refreshTtlSeconds,
      );
      return {
        user: this.publicUser(currentUser),
        tokens: await this.issueTokenPair(trx, currentUser.id, family),
      };
    });
  }

  async refresh(refreshToken: string | undefined): Promise<AuthResult> {
    const claims = await this.verifyToken(refreshToken, REFRESH_TOKEN_TYPE);
    if (!claims) throw new UnauthorizedException('Authentication required');
    const result = await this.repository.transaction(
      async (trx): Promise<RefreshResult> => {
        // Every rotation locks the family first, including rotations of different descendants.
        const family = await this.repository.findFamily(
          claims.familyId,
          trx,
          true,
        );
        const token = await this.repository.findRefresh(
          trx,
          this.hashToken(claims.jti),
        );
        if (
          !family ||
          !token ||
          family.user_id !== claims.sub ||
          token.family_id !== family.id
        )
          return { kind: 'invalid' };
        // Replay must commit revocation even if the family has reached its refresh limit.
        if (token.consumed_at) {
          await this.repository.revokeFamily(family.id, trx);
          return { kind: 'replay' };
        }
        if (
          token.revoked_at ||
          family.revoked_at ||
          new Date(token.expires_at) <= new Date() ||
          new Date(family.expires_at) <= new Date()
        )
          return { kind: 'invalid' };
        const user = await this.repository.findUserForSession(claims.sub, trx);
        if (!user?.is_active) return { kind: 'invalid' };
        const decision = await this.rateLimits.consume(
          'refresh',
          family.id,
          getAuthConfig().refreshLimit,
          trx,
          true,
        );
        if (!decision.allowed)
          return {
            kind: 'limited',
            retryAfterSeconds: decision.retryAfterSeconds,
          };
        const tokens = await this.issueTokenPair(trx, user.id, family);
        const successor = this.jwtService.decode<TokenClaims>(
          tokens.refreshToken,
        );
        await this.repository.consumeRefresh(trx, token.id, successor.jti);
        return {
          kind: 'success',
          result: { user: this.publicUser(user), tokens },
        };
      },
    );
    if (result.kind === 'limited')
      throw new AuthRateLimitException(result.retryAfterSeconds);
    if (result.kind === 'replay') {
      recordAuthEvent('refresh_replay', 401);
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    if (result.kind !== 'success')
      throw new UnauthorizedException('Authentication required');
    return result.result;
  }

  async logout(
    accessToken: string | undefined,
    refreshToken: string | undefined,
  ): Promise<void> {
    const claims =
      (await this.verifyToken(refreshToken, REFRESH_TOKEN_TYPE)) ??
      (await this.verifyToken(accessToken, ACCESS_TOKEN_TYPE));
    if (claims) await this.repository.revokeFamily(claims.familyId);
  }

  async authenticateAccess(
    accessToken: string | undefined,
  ): Promise<PublicUser | null> {
    const claims = await this.verifyToken(accessToken, ACCESS_TOKEN_TYPE);
    if (!claims) return null;
    const family = await this.repository.findFamily(claims.familyId);
    if (
      !family ||
      family.user_id !== claims.sub ||
      family.revoked_at ||
      new Date(family.expires_at) <= new Date()
    )
      return null;
    return (await this.repository.findUser(claims.sub)) ?? null;
  }

  private async issueTokenPair(
    trx: Transaction<DB>,
    userId: string,
    family: Selectable<AuthTokenFamilies>,
  ): Promise<TokenPair> {
    const config = getAuthConfig();
    const now = Math.floor(Date.now() / 1000);
    const familyExpires = Math.floor(
      new Date(family.expires_at).getTime() / 1000,
    );
    if (familyExpires <= now)
      throw new UnauthorizedException('Session expired');
    const accessExpires = now + config.accessTtlSeconds;
    const refreshJti = randomUUID();
    const sign = (
      type: TokenClaims['type'],
      jti: string,
      exp: number,
      secret: string,
    ) =>
      this.jwtService.signAsync(
        { sub: userId, type, familyId: family.id, jti, iat: now, exp },
        {
          secret,
          algorithm: 'HS256',
          issuer: config.issuer,
          audience: config.audience,
        },
      );
    const accessToken = await sign(
      ACCESS_TOKEN_TYPE,
      randomUUID(),
      accessExpires,
      config.accessSecret,
    );
    const refreshToken = await sign(
      REFRESH_TOKEN_TYPE,
      refreshJti,
      familyExpires,
      config.refreshSecret,
    );
    const refreshExpiresAt = new Date(familyExpires * 1000);
    await this.repository.insertRefresh(
      trx,
      refreshJti,
      family.id,
      this.hashToken(refreshJti),
      refreshExpiresAt,
    );
    return {
      accessToken,
      refreshToken,
      accessExpiresAt: new Date(accessExpires * 1000),
      refreshExpiresAt,
    };
  }

  private async verifyToken(
    token: string | undefined,
    expectedType: TokenClaims['type'],
  ): Promise<TokenClaims | null> {
    if (!token) return null;
    const config = getAuthConfig();
    try {
      const claims = await this.jwtService.verifyAsync<TokenClaims>(token, {
        secret:
          expectedType === ACCESS_TOKEN_TYPE
            ? config.accessSecret
            : config.refreshSecret,
        algorithms: ['HS256'],
        issuer: config.issuer,
        audience: config.audience,
      });
      if (
        claims.type !== expectedType ||
        !validUuid(claims.sub) ||
        !validUuid(claims.familyId) ||
        !validUuid(claims.jti) ||
        !Number.isSafeInteger(claims.exp) ||
        !Number.isSafeInteger(claims.iat) ||
        claims.exp <= claims.iat ||
        claims.iat > Math.floor(Date.now() / 1000) ||
        claims.iss !== config.issuer ||
        claims.aud !== config.audience
      )
        return null;
      return claims;
    } catch {
      return null;
    }
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
  private publicUser(user: PublicUser): PublicUser {
    return {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      contact_number: user.contact_number,
    };
  }
}
