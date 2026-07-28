/**
 * Errors we deliberately surface to the caller (and, for tool calls, back to
 * the LLM so it can ask the user for a correction). Anything that is not an
 * AppError is treated as an unexpected bug and reported generically.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', 400, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'NOT_FOUND', 404, details);
    this.name = 'NotFoundError';
  }
}

export class LlmError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 'LLM_ERROR', 502, details);
    this.name = 'LlmError';
  }
}
