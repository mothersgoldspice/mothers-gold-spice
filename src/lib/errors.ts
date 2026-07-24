/**
 * Application errors carry the HTTP status and a stable machine `code` so API
 * routes can translate any thrown error into a response without every handler
 * writing its own try/catch shape.
 *
 * `expose` marks a message as safe to show the customer. Anything unexpected is
 * reported as a generic message with the detail kept in logs only — a SQL error
 * or a provider stack trace must never reach the browser.
 */

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'gone'
  | 'rate_limited'
  | 'payment_failed'
  | 'out_of_stock'
  | 'provider_error'
  | 'internal';

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly expose: boolean;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { status?: number; expose?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? DEFAULT_STATUS[code];
    this.expose = opts.expose ?? this.status < 500;
    this.details = opts.details;
  }
}

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  rate_limited: 429,
  payment_failed: 402,
  out_of_stock: 409,
  provider_error: 502,
  internal: 500,
};

export const badRequest = (m: string, details?: unknown) => new AppError('bad_request', m, { details });
export const validationFailed = (m: string, details?: unknown) => new AppError('validation_failed', m, { details });
export const unauthorized = (m = 'Please sign in to continue.') => new AppError('unauthorized', m);
export const forbidden = (m = 'You do not have access to this.') => new AppError('forbidden', m);
export const notFound = (m = 'Not found.') => new AppError('not_found', m);
export const conflict = (m: string, details?: unknown) => new AppError('conflict', m, { details });
export const rateLimited = (m = 'Too many attempts. Please try again in a minute.') =>
  new AppError('rate_limited', m);
export const outOfStock = (m: string, details?: unknown) => new AppError('out_of_stock', m, { details });
export const providerError = (m: string, cause?: unknown) =>
  new AppError('provider_error', m, { expose: false, cause });
export const internal = (m: string, cause?: unknown) => new AppError('internal', m, { expose: false, cause });

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Message safe to render to an end user, whatever was thrown. */
export function publicMessage(err: unknown): string {
  if (isAppError(err) && err.expose) return err.message;
  return 'Something went wrong on our side. Please try again.';
}
