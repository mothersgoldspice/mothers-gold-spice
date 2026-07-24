/**
 * CSRF protection: signed double-submit token plus an Origin check.
 *
 * The token is `<random>.<hmac(secret, random)>`. It is stored in an HttpOnly
 * cookie and also rendered into every form (and a `<meta>` tag for fetch calls).
 * A cross-site attacker can neither read the cookie nor forge the HMAC, so a
 * request whose submitted token matches the cookie must have come from a page we
 * rendered.
 *
 * The Origin/Referer check runs first and rejects outright — it is cheap, and it
 * catches the common case before any crypto work happens.
 */

import type { AstroCookies } from 'astro';
import { hmacSha256Hex, timingSafeEqual } from '../crypto';
import { forbidden } from '../errors';
import { sessionSecret, siteUrl, type Env } from '../env';
import { newToken } from '../ids';
import { log } from '../log';
import { CSRF_COOKIE, SESSION_TTL_MS, setCookie } from './cookies';

const SEPARATOR = '.';

export async function issueCsrfToken(env: Env): Promise<string> {
  const nonce = newToken(16);
  const mac = await hmacSha256Hex(sessionSecret(env), nonce);
  return `${nonce}${SEPARATOR}${mac}`;
}

export async function isValidCsrfToken(env: Env, token: string): Promise<boolean> {
  const [nonce, mac] = token.split(SEPARATOR);
  if (!nonce || !mac) return false;
  const expected = await hmacSha256Hex(sessionSecret(env), nonce);
  return timingSafeEqual(expected, mac);
}

/** Read the cookie, minting and setting a fresh token when absent. */
export async function ensureCsrfToken(cookies: AstroCookies, env: Env): Promise<string> {
  const existing = cookies.get(CSRF_COOKIE)?.value;
  if (existing && (await isValidCsrfToken(env, existing))) return existing;

  const token = await issueCsrfToken(env);
  setCookie(cookies, env, CSRF_COOKIE, token, SESSION_TTL_MS);
  return token;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Enforce CSRF on a state-changing request. Throws `forbidden` on failure.
 *
 * Webhook routes are exempt and must NOT call this: a payment provider has no
 * cookie and no same-site origin. Their authenticity comes from the provider
 * signature check instead, which is strictly stronger.
 */
export async function assertCsrf(request: Request, cookies: AstroCookies, env: Env): Promise<void> {
  if (SAFE_METHODS.has(request.method)) return;

  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const expectedOrigin = new URL(siteUrl(env)).origin;
  const requestOrigin = new URL(request.url).origin;

  if (origin) {
    // Accept both the configured public URL and the origin actually serving the
    // request — a workers.dev preview and the custom domain are both legitimate.
    if (origin !== expectedOrigin && origin !== requestOrigin) {
      log.warn('csrf.origin_mismatch', { origin, expectedOrigin, requestOrigin });
      throw forbidden('Request blocked: unrecognised origin.');
    }
  } else if (referer) {
    const refOrigin = new URL(referer).origin;
    if (refOrigin !== expectedOrigin && refOrigin !== requestOrigin) {
      log.warn('csrf.referer_mismatch', { refOrigin });
      throw forbidden('Request blocked: unrecognised referrer.');
    }
  }

  const cookieToken = cookies.get(CSRF_COOKIE)?.value ?? '';
  const submitted = await extractSubmittedToken(request);

  if (!cookieToken || !submitted) {
    log.warn('csrf.token_missing', { hasCookie: Boolean(cookieToken), hasSubmitted: Boolean(submitted) });
    throw forbidden('Your session expired. Please refresh the page and try again.');
  }
  if (!timingSafeEqual(cookieToken, submitted)) {
    log.warn('csrf.token_mismatch');
    throw forbidden('Your session expired. Please refresh the page and try again.');
  }
  if (!(await isValidCsrfToken(env, submitted))) {
    log.warn('csrf.token_invalid_signature');
    throw forbidden('Your session expired. Please refresh the page and try again.');
  }
}

/**
 * Pull the token from the header first, then a form field.
 *
 * The request body is cloned before reading so the handler can still consume it
 * — a Request body is a one-shot stream.
 */
async function extractSubmittedToken(request: Request): Promise<string> {
  const header = request.headers.get('x-csrf-token');
  if (header) return header;

  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    try {
      const form = await request.clone().formData();
      const value = form.get('_csrf');
      return typeof value === 'string' ? value : '';
    } catch {
      return '';
    }
  }
  return '';
}
