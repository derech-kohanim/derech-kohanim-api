import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

import { AppException } from '../common/app-exception';
import { AuthService, type AccessTokenClaims } from './auth.service';

export interface AuthenticatedRequest extends Request {
  auth?: AccessTokenClaims;
}

function readBearer(request: AuthenticatedRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

/** Requires a valid access token. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readBearer(request);
    if (!token) {
      throw AppException.unauthorized('token_missing', 'Authorization bearer token required');
    }
    request.auth = this.auth.verifyAccessToken(token);
    return true;
  }
}

/**
 * Accepts anonymous callers. Guests are a first-class tier (spec section 4), so routing and
 * place search must work without an account - they just get fewer personalised results.
 */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readBearer(request);
    if (token) {
      try {
        request.auth = this.auth.verifyAccessToken(token);
      } catch {
        // An expired token on an optional route degrades to guest rather than failing.
      }
    }
    return true;
  }
}

export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.auth?.sub ?? null;
  },
);

export const RequiredUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.auth?.sub) {
      throw AppException.unauthorized('token_missing', 'This endpoint requires an account');
    }
    return request.auth.sub;
  },
);
