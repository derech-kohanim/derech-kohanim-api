import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';

import type { AuthenticatedRequest } from '../auth/auth.guard';
import { AppException } from '../common/app-exception';
import { config } from '../config';
import { PrismaService } from '../db/prisma.service';

/** Carries the resolved admin email through to the handler once the guard has run. */
export interface AdminRequest extends AuthenticatedRequest {
  adminEmail?: string;
}

/**
 * Admin allow-list gate. Runs AFTER JwtAuthGuard (which populates request.auth), so it can
 * trust the token is valid and only decides authorisation: is this user's email in
 * ADMIN_EMAILS? The email usually rides on the JWT, but a token minted before the email claim
 * existed is tolerated by looking the user up. Non-admins get a 403.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const claims = request.auth;
    if (!claims?.sub) {
      // Belt and suspenders: JwtAuthGuard should already have rejected this.
      throw AppException.unauthorized('token_missing', 'This endpoint requires an account');
    }

    let email = claims.email?.trim().toLowerCase() ?? null;
    if (!email) {
      const user = await this.prisma.user.findUnique({ where: { id: claims.sub } });
      email = user?.email?.trim().toLowerCase() ?? null;
    }

    if (!email || !config.adminEmails.includes(email)) {
      throw AppException.forbidden('not_admin', 'This account is not an administrator');
    }

    request.adminEmail = email;
    return true;
  }
}

/** The resolved admin email, populated by AdminGuard. */
export const AdminEmail = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    if (!request.adminEmail) {
      throw AppException.forbidden('not_admin', 'Admin email was not resolved');
    }
    return request.adminEmail;
  },
);
