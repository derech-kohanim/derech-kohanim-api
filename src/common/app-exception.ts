import { HttpException, HttpStatus } from '@nestjs/common';

import type { ApiError } from '@shared';

/**
 * Every error the API returns carries a stable `code` the client translates, plus a
 * `message` that is only ever meant for logs (spec section 14.4).
 */
export class AppException extends HttpException {
  constructor(status: HttpStatus, error: ApiError) {
    super(error, status);
  }

  static badRequest(code: string, message: string, details?: Record<string, unknown>) {
    return new AppException(HttpStatus.BAD_REQUEST, { code, message, details });
  }

  static unauthorized(code: string, message: string) {
    return new AppException(HttpStatus.UNAUTHORIZED, { code, message });
  }

  static forbidden(code: string, message: string) {
    return new AppException(HttpStatus.FORBIDDEN, { code, message });
  }

  static notFound(code: string, message: string) {
    return new AppException(HttpStatus.NOT_FOUND, { code, message });
  }

  static conflict(code: string, message: string) {
    return new AppException(HttpStatus.CONFLICT, { code, message });
  }

  /** Upstream provider failure. Not the client's fault, so never a 4xx. */
  static badGateway(code: string, message: string, details?: Record<string, unknown>) {
    return new AppException(HttpStatus.BAD_GATEWAY, { code, message, details });
  }
}
