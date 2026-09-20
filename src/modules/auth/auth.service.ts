import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Kysely, Selectable, Transaction } from 'kysely';
import * as argon2 from 'argon2';

import type { AuthUsers, DB } from '../../database/db';
import { DATABASE } from '../../database/database.module';
import { SESSION_TTL_MS } from '../../common/constants/auth.constants';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';

const PASSWORD_HASH_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

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

export type AuthenticatedSession = {
  sessionId: string;
  user: PublicUser;
};

@Injectable()
export class AuthService {
  private readonly dummyPasswordHashPromise = argon2.hash(
    'coms-dummy-password-value',
    PASSWORD_HASH_OPTIONS,
  );

  constructor(
    @Inject(DATABASE)
    private readonly db: Kysely<DB>,
  ) {}

  async register(dto: RegisterDto): Promise<{
    user: PublicUser;
    token: string;
  }> {
    const email = dto.email.trim().toLowerCase();
    const fullName = dto.fullName.trim();
    const contactNumber = dto.contactNumber.trim();

    const passwordHash = await argon2.hash(dto.password, PASSWORD_HASH_OPTIONS);

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

        const token = await this.createSession(trx, user.id);

        return {
          user: this.toPublicUser(user),
          token,
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

  async login(dto: LoginDto): Promise<{
    user: PublicUser;
    token: string;
  }> {
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

    const token = await this.createSession(this.db, user.id);

    return {
      user: this.toPublicUser(user),
      token,
    };
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) {
      return;
    }

    await this.db
      .updateTable('auth.sessions')
      .set({ revoked_at: new Date() })
      .where('token_hash', '=', this.hashToken(token))
      .where('revoked_at', 'is', null)
      .execute();
  }

  async authenticateSession(
    token: string | undefined,
  ): Promise<AuthenticatedSession | null> {
    if (!token) {
      return null;
    }

    const session = await this.db
      .selectFrom('auth.sessions as session')
      .innerJoin('auth.users as user', 'user.id', 'session.user_id')
      .select([
        'session.id as sessionId',
        'user.id as userId',
        'user.email',
        'user.full_name',
        'user.contact_number',
      ])
      .where('session.token_hash', '=', this.hashToken(token))
      .where('session.revoked_at', 'is', null)
      .where('session.expires_at', '>', new Date())
      .executeTakeFirst();

    if (!session) {
      return null;
    }

    return {
      sessionId: session.sessionId,
      user: {
        id: session.userId,
        email: session.email,
        full_name: session.full_name,
        contact_number: session.contact_number,
      },
    };
  }

  private async createSession(
    db: Kysely<DB> | Transaction<DB>,
    userId: string,
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await db
      .insertInto('auth.sessions')
      .values({
        user_id: userId,
        token_hash: this.hashToken(token),
        expires_at: expiresAt,
      })
      .execute();

    return token;
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
