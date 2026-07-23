import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { config } from '../config';
import { AuthController } from './auth.controller';
import { JwtAuthGuard, OptionalAuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { TermsService } from './terms.service';

@Global()
@Module({
  imports: [
    JwtModule.register({
      secret: config.jwtSecret,
      signOptions: { expiresIn: config.accessTokenTtlSeconds },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TermsService, JwtAuthGuard, OptionalAuthGuard],
  exports: [AuthService, TermsService, JwtAuthGuard, OptionalAuthGuard],
})
export class AuthModule {}
