import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { CommerceError } from '../commercetools.js';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof CommerceError) {
      res.status(exception.status).json({ error: { code: exception.code, message: exception.message } });
      return;
    }
    const type = typeof exception === 'object' && exception !== null && 'type' in exception ? exception.type : undefined;
    if (type === 'entity.parse.failed' || type === 'entity.too.large') {
      res.status(type === 'entity.too.large' ? 413 : 400).json({ error: { code: 'InvalidBody', message: 'Expected valid JSON up to 16kb' } });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      res.status(status).json({ error: {
        code: status === 404 ? 'NotFound' : 'HttpError',
        message: status === 404 ? 'Route not found' : 'Unable to complete request',
      } });
      return;
    }
    res.status(502).json({ error: { code: 'ServiceUnavailable', message: 'Unable to complete commerce request' } });
  }
}
