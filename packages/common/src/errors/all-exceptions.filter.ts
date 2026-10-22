import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { getCorrelationId } from '../correlation';

export interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  correlationId?: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const correlationId = getCorrelationId();
    let body: ErrorBody;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const obj = typeof response === 'object' ? (response as Record<string, unknown>) : {};
      body = {
        statusCode: status,
        error: typeof obj.error === 'string' ? obj.error : (HttpStatus[status] ?? 'Error'),
        message:
          (obj.message as string | string[] | undefined) ??
          (typeof response === 'string' ? response : exception.message),
        correlationId,
      };
    } else {
      this.logger.error(
        `[${correlationId}] ${exception instanceof Error ? exception.stack : String(exception)}`,
      );
      body = {
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal server error',
        correlationId,
      };
    }
    res.status(body.statusCode).json(body);
  }
}
