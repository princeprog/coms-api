import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import type { Kysely, Selectable, Transaction } from 'kysely';
import * as argon2 from 'argon2';

import type { AuthTokenFamilies, AuthUsers, DB } from '../../database/db';
import { DATABASE } from '../../database/database.module';
import {
  ACCESS_TOKEN_TYPE,
  getAuthConfig,
  REFRESH_TOKEN_TYPE,
} from '../../config/auth.config';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import { hashPassword, PASSWORD_HASH_OPTIONS } from './password-hashing';

export type PublicUser = {
  id: string;
  email: string;
  full_name: string;
  contact_number: string;
};

type UserIdentity = Pick<
  Selectable<AuthUsers>,
  'id' | 'email' | 'full_name' | 'contact_number'
>;

export type TokenClaims = {
  sub: string;
  type: typeof ACCESS_TOKEN_TYPE | typeof REFRESH_TOKEN_TYPE;
  familyId: string;
  jti: string;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string | string[];
};

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

export type AuthResult = {
  user: PublicUser;
  tokens: TokenPair;
};

type Family = Selectable<AuthTokenFamilies>;

type RefreshResult =
  | { kind: 'success'; result: AuthResult }
  | { kind: 'replay' }
  | { kind: 'invalid' };

@Injectable()
export class AuthService {
  private readonly dummyPasswordHashPromise = argon2.hash(
    'coms-dummy-password-value',
    PASSWORD_HASH_OPTIONS,
  );

  constructor(
    @Inject(DATABASE)
    private readonly db: Kysely<DB>,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const email = dto.email.trim().toLowerCase();
    const fullName = dto.fullName.trim();
    const contactNumber = dto.contactNumber.trim();
    const passwordHash = await hashPassword(dto.password);

    try {
      return await this.db.transaction().execute(async (trx) => {
        const existingUser = await trx
          .selectFrom('auth.users')
          .select('id')
          .where((expressionBuilder) =>
            expressionBuilder.or([
              expressionBuilder('email', '=', email),
              expressionBuilder('contact_number', '=', contactNumber),
            ]),
          )
          .executeTakeFirst();

        if (existingUser) {
          throw new ConflictException(
            'Email or contact number is already registered',
          );
        }

        const user = await trx
          .insertInto('auth.users')
          .values({
            email,
            full_name: fullName,
            contact_number: contactNumber,
            hashed_password: passwordHash,
          })
          .returning(['id', 'email', 'full_name', 'contact_number'])
          .executeTakeFirstOrThrow();

        const family = await this.createFamily(trx, user.id);
        return {
          user: this.toPublicUser(user),
          tokens: await this.issueTokenPair(trx, user.id, family),
        };
      });
    } catch (error) {
      if (error instanceof ConflictException) {
        throw error;
      }
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          'Email or contact number is already registered',
        );
      }
      throw error;
    }
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.db
      .selectFrom('auth.users')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst();

    const passwordHash =
      user?.hashed_password ?? (await this.dummyPasswordHashPromise);
    const passwordMatches = await argon2.verify(passwordHash, dto.password);

    if (!user || !passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.db.transaction().execute(async (trx) => {
      const family = await this.createFamily(trx, user.id);
      return {
        user: this.toPublicUser(user),
        tokens: await this.issueTokenPair(trx, user.id, family),
      };
    });
  }

  async refresh(refreshToken: string | undefined): Promise<AuthResult> {
    const claims = await this.verifyToken(refreshToken, REFRESH_TOKEN_TYPE);
    if (!claims) {
      throw new UnauthorizedException('Authentication required');
    }

    const result = await this.db
      .transaction()
      .execute(async (trx): Promise<RefreshResult> => {
        const token = await trx
          .selectFrom('auth.refresh_tokens as token')
          .innerJoin(
            'auth.token_families as family',
            'family.id',
            'token.family_id',
          )
          .select([
            'token.id',
            'token.family_id',
            'token.expires_at',
            'token.consumed_at',
            'token.revoked_at',
            'family.user_id',
            'family.expires_at as family_expires_at',
            'family.revoked_at as family_revoked_at',
          ])
          .where('token.token_hash', '=', this.hashToken(claims.jti))
          .forUpdate()
          .executeTakeFirst();

        if (
          !token ||
          token.family_id !== claims.familyId ||
          token.user_id !== claims.sub
        ) {
          return { kind: 'invalid' };
        }

        const now = new Date();
        if (
          token.consumed_at ||
          token.revoked_at ||
          token.family_revoked_at ||
          new Date(token.expires_at) <= now ||
          new Date(token.family_expires_at) <= now
        ) {
          if (token.consumed_at) {
            await this.revokeFamily(trx, token.family_id);
            return { kind: 'replay' };
          }
          return { kind: 'invalid' };
        }

        const family = await trx
          .selectFrom('auth.token_families')
          .selectAll()
          .where('id', '=', token.family_id)
          .executeTakeFirstOrThrow();
        const user = await this.findUser(trx, token.user_id);
        if (!user) {
          return { kind: 'invalid' };
        }

        const successor = await this.issueTokenPair(trx, user.id, family);
        const successorClaims = await this.verifyToken(
          successor.refreshToken,
          REFRESH_TOKEN_TYPE,
        );
        if (!successorClaims) {
          throw new UnauthorizedException('Unable to create refresh token');
        }

        await trx
          .updateTable('auth.refresh_tokens')
          .set({ consumed_at: now, replaced_by_id: successorClaims.jti })
          .where('id', '=', token.id)
          .execute();

        return {
          kind: 'success',
          result: { user: this.toPublicUser(user), tokens: successor },
        };
      });

    if (result.kind === 'replay') {
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    if (result.kind !== 'success') {
      throw new UnauthorizedException('Authentication required');
    }
    return result.result;
  }

  async logout(
    accessToken: string | undefined,
    refreshToken: string | undefined,
  ): Promise<void> {
    const refreshClaims = await this.verifyToken(
      refreshToken,
      REFRESH_TOKEN_TYPE,
    );
    const accessClaims = refreshClaims
      ? null
      : await this.verifyToken(accessToken, ACCESS_TOKEN_TYPE);
    const familyId = refreshClaims?.familyId ?? accessClaims?.familyId;
    if (familyId) {
      await this.revokeFamily(this.db, familyId);
    }
  }

  async authenticateAccess(
    accessToken: string | undefined,
  ): Promise<PublicUser | null> {
    const claims = await this.verifyToken(accessToken, ACCESS_TOKEN_TYPE);
    if (!claims) {
      return null;
    }

    const family = await this.db
      .selectFrom('auth.token_families')
      .select(['user_id', 'expires_at', 'revoked_at'])
      .where('id', '=', claims.familyId)
      .executeTakeFirst();
    if (
      !family ||
      family.user_id !== claims.sub ||
      family.revoked_at ||
      new Date(family.expires_at) <= new Date()
    ) {
      return null;
    }

    const user = await this.findUser(this.db, claims.sub);
    return user ? this.toPublicUser(user) : null;
  }

  private async createFamily(
    db: Kysely<DB> | Transaction<DB>,
    userId: string,
  ): Promise<Family> {
    const config = getAuthConfig();
    return db
      .insertInto('auth.token_families')
      .values({
        user_id: userId,
        expires_at: new Date(Date.now() + config.refreshTtlSeconds * 1000),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  private async issueTokenPair(
    db: Kysely<DB> | Transaction<DB>,
    userId: string,
    family: Family,
  ): Promise<TokenPair> {
    const config = getAuthConfig();
    const now = Math.floor(Date.now() / 1000);
    const familyExpires = Math.floor(
      new Date(family.expires_at).getTime() / 1000,
    );
    const refreshTtl = Math.max(1, familyExpires - now);
    const accessToken = await this.jwtService.signAsync(
      {
        sub: userId,
        type: ACCESS_TOKEN_TYPE,
        familyId: family.id,
        jti: randomUUID(),
      },
      {
        secret: config.accessSecret,
        algorithm: 'HS256',
        issuer: config.issuer,
        audience: config.audience,
        expiresIn: config.accessTtlSeconds,
      },
    );
    const refreshJti = randomUUID();
    const refreshToken = await this.jwtService.signAsync(
      {
        sub: userId,
        type: REFRESH_TOKEN_TYPE,
        familyId: family.id,
        jti: refreshJti,
      },
      {
        secret: config.refreshSecret,
        algorithm: 'HS256',
        issuer: config.issuer,
        audience: config.audience,
        expiresIn: refreshTtl,
      },
    );

    await db
      .insertInto('auth.refresh_tokens')
      .values({
        id: refreshJti,
        family_id: family.id,
        token_hash: this.hashToken(refreshJti),
        expires_at: new Date(Math.min(familyExpires, now + refreshTtl) * 1000),
      })
      .execute();

    return { accessToken, refreshToken };
  }

  private async verifyToken(
    token: string | undefined,
    expectedType: TokenClaims['type'],
  ): Promise<TokenClaims | null> {
    if (!token) {
      return null;
    }
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
        !claims.type ||
        claims.type !== expectedType ||
        !claims.sub ||
        !claims.familyId ||
        !claims.jti
      ) {
        return null;
      }
      return claims;
    } catch {
      return null;
    }
  }

  private async findUser(
    db: Kysely<DB> | Transaction<DB>,
    userId: string,
  ): Promise<UserIdentity | undefined> {
    return db
      .selectFrom('auth.users')
      .select(['id', 'email', 'full_name', 'contact_number'])
      .where('id', '=', userId)
      .executeTakeFirst();
  }

  private async revokeFamily(
    db: Kysely<DB> | Transaction<DB>,
    familyId: string,
  ): Promise<void> {
    await db
      .updateTable('auth.token_families')
      .set({ revoked_at: new Date() })
      .where('id', '=', familyId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toPublicUser(user: UserIdentity): PublicUser {
    return {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      contact_number: user.contact_number,
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    );
  }
}
