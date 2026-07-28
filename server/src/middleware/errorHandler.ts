import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors.js';

/** Express 4 does not catch rejected promises from async handlers; this does. */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
}

/** Single place where an exception becomes an HTTP response body. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request body.',
        details: err.issues.map((i) => ({ field: i.path.join('.') || '(root)', problem: i.message })),
      },
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.httpStatus).json({
      error: { code: err.code, message: err.message, details: err.details ?? undefined },
    });
    return;
  }

  // Unexpected: log the real thing server-side, return something generic.
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
  });
}
