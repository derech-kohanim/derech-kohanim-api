import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { LANGUAGES } from '../common/dto';
import { PrismaService } from '../db/prisma.service';
import { toUser } from '../users/user.mapper';
import { AppException } from '../common/app-exception';
import {
  AcceptTermsDto,
  DevLoginDto,
  GoogleAuthDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
} from './auth.dto';
import { JwtAuthGuard, RequiredUserId } from './auth.guard';
import { AuthService } from './auth.service';
import { TermsService } from './terms.service';
import type { AuthResponse, Language, TermsDocument, User } from '@shared';

@ApiTags('auth')
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly terms: TermsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('terms')
  @ApiOperation({ summary: 'Current terms document, which registration must accept' })
  async getTerms(@Query('language') language = 'he'): Promise<TermsDocument> {
    const lang = (LANGUAGES as string[]).includes(language) ? (language as Language) : 'he';
    return this.terms.get(lang);
  }

  @Post('register')
  @ApiOperation({ summary: 'Email and password registration with terms acceptance' })
  async register(@Body() body: RegisterDto): Promise<AuthResponse> {
    return this.auth.register(body);
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email and password login' })
  async login(@Body() body: LoginDto): Promise<AuthResponse> {
    return this.auth.login(body.email, body.password);
  }

  @Post('google')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange a Google ID token for our own tokens' })
  async google(@Body() body: GoogleAuthDto): Promise<AuthResponse> {
    return this.auth.loginWithGoogle(body.idToken, body.acceptedTermsVersion);
  }

  @Post('dev-login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Development only login shortcut',
    description:
      'Returns tokens for a demo account without any credential. Disabled unless ' +
      'AUTH_DEV_LOGIN_ENABLED=true, so it can never be reached in production.',
  })
  async devLogin(@Body() body: DevLoginDto): Promise<AuthResponse> {
    return this.auth.devLogin(body.email);
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate a refresh token for a new token pair' })
  async refresh(@Body() body: RefreshDto): Promise<AuthResponse> {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke a refresh token' })
  async logout(@Body() body: RefreshDto): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'The signed in user' })
  async me(@RequiredUserId() userId: string): Promise<User> {
    const row = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!row) throw AppException.notFound('user_not_found', 'User no longer exists');
    return toUser(row);
  }

  @Post('accept-terms')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Record acceptance of a newer terms version' })
  async acceptTerms(
    @RequiredUserId() userId: string,
    @Body() body: AcceptTermsDto,
  ): Promise<User> {
    return this.auth.acceptTerms(userId, body.version);
  }
}
