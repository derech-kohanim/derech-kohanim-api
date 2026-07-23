import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

import type { ApiError } from '@shared';

/** Normalises everything thrown anywhere in the app into the `ApiError` shape. */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json(this.toApiError(exception, status));
      return;
    }

    const message = exception instanceof Error ? exception.message : String(exception);
    this.logger.error(message, exception instanceof Error ? exception.stack : undefined);
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ code: 'internal_error', message } satisfies ApiError);
  }

  private toApiError(exception: HttpException, status: number): ApiError {
    const body = exception.getResponse();

    if (typeof body === 'object' && body !== null && 'code' in body) {
      return body as ApiError;
    }

    // Nest built-ins (validation pipe, 404 handler) arrive without a code.
    const raw = body as { message?: string | string[]; error?: string };
    const details =
      Array.isArray(raw?.message) ? { violations: raw.message } : undefined;

    return {
      code: DEFAULT_CODES[status] ?? 'request_failed',
      message: Array.isArray(raw?.message)
        ? raw.message.join('; ')
        : (raw?.message ?? exception.message),
      details,
    };
  }
}

const DEFAULT_CODES: Record<number, string> = {
  400: 'invalid_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
  502: 'upstream_failed',
};
