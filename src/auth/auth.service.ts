import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';

import { AppException } from '../common/app-exception';
import { config } from '../config';
import { PrismaService } from '../db/prisma.service';
import { DEFAULT_PREFERENCES, toUser } from '../users/user.mapper';
import { TermsService } from './terms.service';
import type { AuthProvider, AuthResponse, AuthTokens, User } from '@shared';

export interface AccessTokenClaims {
  sub: string;
  tier: string;
  email: string | null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly google = new OAuth2Client();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly terms: TermsService,
  ) {}

  async register(input: {
    email: string;
    password: string;
    displayName?: string;
    acceptedTermsVersion: string;
  }): Promise<AuthResponse> {
    const email = input.email.trim().toLowerCase();
    await this.assertTermsAccepted(input.acceptedTermsVersion);

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw AppException.conflict('email_taken', 'That email is already registered');
    }

    const row = await this.prisma.user.create({
      data: {
        email,
        passwordHash: await argonHash(input.password),
        displayName: input.displayName?.trim() || null,
        tier: 'registered',
        providers: ['password'],
        preferences: DEFAULT_PREFERENCES as unknown as object,
        acceptedTermsVersion: input.acceptedTermsVersion,
        acceptedTermsAt: new Date(),
      },
    });

    return this.issue(toUser(row));
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    const row = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });

    // Same error for unknown email and wrong password: never confirm which one exists.
    if (!row?.passwordHash || !(await argonVerify(row.passwordHash, password))) {
      throw AppException.unauthorized('invalid_credentials', 'Email or password is wrong');
    }
    return this.issue(toUser(row));
  }

  /**
   * Verifies a Google Identity Services ID token server side. The client never sends us a
   * profile it made up - only the signed token.
   */
  async loginWithGoogle(idToken: string, acceptedTermsVersion?: string): Promise<AuthResponse> {
    if (!config.googleClientId) {
      throw AppException.badRequest(
        'google_not_configured',
        'GOOGLE_CLIENT_ID is not set on this server',
      );
    }

    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.google.verifyIdToken({
        idToken,
        audience: [config.googleClientId, ...config.googleExtraClientIds],
      });
      payload = ticket.getPayload();
    } catch (error) {
      this.logger.warn(`Google ID token rejected: ${(error as Error).message}`);
      throw AppException.unauthorized('google_token_invalid', 'Google ID token is not valid');
    }

    if (!payload?.sub) {
      throw AppException.unauthorized('google_token_invalid', 'Google ID token has no subject');
    }

    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ googleSub: payload.sub }, { email: payload.email ?? '__none__' }] },
    });

    if (existing) {
      const providers = new Set<AuthProvider>(existing.providers as AuthProvider[]);
      providers.add('google');
      const updated = await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          googleSub: payload.sub,
          providers: [...providers],
          displayName: existing.displayName ?? payload.name ?? null,
          ...(acceptedTermsVersion
            ? { acceptedTermsVersion, acceptedTermsAt: new Date() }
            : {}),
        },
      });
      return this.issue(toUser(updated));
    }

    // A brand new account still has to accept the terms.
    const version = acceptedTermsVersion ?? '';
    await this.assertTermsAccepted(version);

    const created = await this.prisma.user.create({
      data: {
        email: payload.email?.toLowerCase() ?? null,
        googleSub: payload.sub,
        displayName: payload.name ?? null,
        tier: 'registered',
        providers: ['google'],
        preferences: DEFAULT_PREFERENCES as unknown as object,
        acceptedTermsVersion: version,
        acceptedTermsAt: new Date(),
      },
    });
    return this.issue(toUser(created));
  }

  /**
   * Development shortcut so the web client can sign in before any Google credential exists.
   * Refuses to run unless AUTH_DEV_LOGIN_ENABLED is explicitly on.
   */
  async devLogin(email?: string): Promise<AuthResponse> {
    if (!config.devLoginEnabled) {
      throw AppException.forbidden(
        'dev_login_disabled',
        'Set AUTH_DEV_LOGIN_ENABLED=true to use the development login',
      );
    }

    const address = (email ?? config.devLoginEmail).trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email: address } });
    if (existing) return this.issue(toUser(existing));

    const version = await this.terms.currentVersion().catch(() => 'dev');
    const created = await this.prisma.user.create({
      data: {
        email: address,
        displayName: 'Demo user',
        tier: 'verified',
        providers: ['password'],
        preferences: DEFAULT_PREFERENCES as unknown as object,
        acceptedTermsVersion: version,
        acceptedTermsAt: new Date(),
      },
    });
    return this.issue(toUser(created));
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    const tokenHash = hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw AppException.unauthorized('refresh_token_invalid', 'Refresh token is not usable');
    }

    // Rotation: a refresh token is single use.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issue(toUser(stored.user));
  }

  async logout(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async acceptTerms(userId: string, version: string): Promise<User> {
    await this.assertTermsAccepted(version);
    const row = await this.prisma.user.update({
      where: { id: userId },
      data: { acceptedTermsVersion: version, acceptedTermsAt: new Date() },
    });
    return toUser(row);
  }

  verifyAccessToken(token: string): AccessTokenClaims {
    try {
      return this.jwt.verify<AccessTokenClaims>(token);
    } catch {
      throw AppException.unauthorized('token_invalid', 'Access token is missing or expired');
    }
  }

  private async assertTermsAccepted(version: string): Promise<void> {
    const current = await this.terms.currentVersion();
    if (version !== current) {
      throw AppException.badRequest(
        'terms_not_accepted',
        `acceptedTermsVersion must be "${current}"`,
        { currentVersion: current },
      );
    }
  }

  private async issue(user: User): Promise<AuthResponse> {
    const tokens = await this.issueTokens(user);
    return { user, tokens };
  }

  private async issueTokens(user: User): Promise<AuthTokens> {
    const accessToken = this.jwt.sign({
      sub: user.id,
      tier: user.tier,
      email: user.email,
    } satisfies AccessTokenClaims);

    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
    );
    await this.prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: hashToken(refreshToken), expiresAt },
    });

    return { accessToken, refreshToken, expiresIn: config.accessTokenTtlSeconds };
  }
}

/** Refresh tokens are stored hashed, so a database dump does not hand out sessions. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
