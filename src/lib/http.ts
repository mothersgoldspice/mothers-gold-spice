/**
 * HTTP helpers shared by every API route.
 *
 * A route's job is to validate input, call a service and return `ok(...)`. The
 * error translation lives here so no handler has to remember which errors are
 * safe to echo — `fail()` decides that from the AppError's `expose` flag.
 */

import { AppError, isAppError, publicMessage } from './errors';
import { errMessage, log } from './log';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

export function ok<T>(data: T, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ ok: true, data } satisfies ApiSuccess<T>), {
    status: init.status ?? 200,
    headers: { ...JSON_HEADERS, ...(init.headers as Record<string, string> | undefined) },
  });
}

export function created<T>(data: T): Response {
  return ok(data, { status: 201 });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/**
 * Turn any throwable into a response. Unexpected errors are logged with their
 * detail and answered with a generic message — a stack trace or a SQL string in
 * a JSON body is an information leak.
 */
export function fail(err: unknown): Response {
  const appErr = isAppError(err) ? err : null;
  const status = appErr?.status ?? 500;

  if (!appErr || status >= 500) {
    log.error('api.unhandled_error', {
      error: errMessage(err),
      ...(err instanceof Error && err.stack ? { stack: err.stack.split('\n').slice(0, 5).join(' | ') } : {}),
    });
  } else {
    log.info('api.client_error', { code: appErr.code, message: appErr.message, status });
  }

  const body: ApiFailure = {
    ok: false,
    error: {
      code: appErr?.code ?? 'internal',
      message: publicMessage(err),
      ...(appErr?.expose && appErr.details !== undefined ? { details: appErr.details } : {}),
    },
  };
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Wrap a handler so thrown AppErrors become responses. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return fail(err);
  }
}

/** Redirect, defaulting to 303 so a POST-redirect-GET does not repost. */
export function redirect(location: string, status: 302 | 303 | 307 = 303): Response {
  return new Response(null, { status, headers: { Location: location } });
}

/** Parse a JSON body, rejecting oversized or malformed payloads. */
export async function readJson<T = unknown>(request: Request, maxBytes = 64 * 1024): Promise<T> {
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new AppError('bad_request', 'Request body is too large.');
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError('bad_request', 'Request body is not valid JSON.');
  }
}

/** Read an HTML form body into a plain object (last value wins for repeats). */
export async function readForm(request: Request): Promise<Record<string, string>> {
  const form = await request.formData();
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** Best-effort client IP behind Cloudflare. */
export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    '0.0.0.0'
  );
}

/** Cache headers for responses that must never be stored (anything per-user). */
export const NO_STORE = { 'Cache-Control': 'no-store, must-revalidate', Pragma: 'no-cache' };
