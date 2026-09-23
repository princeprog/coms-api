import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthGuard } from '../../common/guards/auth.guard';
import { AuthOriginGuard } from '../../common/guards/auth-origin.guard';
import { getAuthConfig } from '../../config/auth.config';
import { DatabaseModule } from '../../database/database.module';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthCapacityGuard } from '../../common/guards/auth-capacity.guard';
import { AuthRateLimitRepository } from './auth-rate-limit.repository';
import { AuthRepository } from './auth.repository';

@Module({
  imports: [
    DatabaseModule,
    JwtModule.registerAsync({
      useFactory: () => {
        const config = getAuthConfig();
        return {
          secret: config.accessSecret,
          signOptions: {
            algorithm: 'HS256' as const,
            issuer: config.issuer,
            audience: config.audience,
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    AuthGuard,
    AuthOriginGuard,
    AuthGatewayGuard,
    AuthCapacityGuard,
    AuthRateLimitRepository,
    AuthRateLimitService,
  ],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
