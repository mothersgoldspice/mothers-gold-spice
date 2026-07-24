/**
 * Request middleware: build the context, resolve the session, enforce CSRF,
 * and add security headers.
 *
 * Astro runs middleware at BUILD time for prerendered pages too, where there is
 * no Cloudflare runtime and no D1. Those requests are detected by the absence of
 * `locals.runtime` and passed straight through — the marketing pages need
 * nothing from here.
 */

import { defineMiddleware } from 'astro:middleware';
import { AppContext } from './lib/context';
import { CART_COOKIE, SESSION_COOKIE } from './lib/auth/cookies';
import { assertCsrf, ensureCsrfToken } from './lib/auth/csrf';
import { resolveSession } from './lib/auth/session';
import type { Env } from './lib/env';
import { fail } from './lib/http';
import { clientIp } from './lib/http';
import { errMessage, log } from './lib/log';

/**
 * Paths exempt from CSRF. Provider callbacks arrive with no cookie and no
 * same-site origin; their authenticity is established by a signature check
 * inside the handler, which is strictly stronger than a double-submit token.
 */
const CSRF_EXEMPT_PREFIXES = ['/api/webhooks/', '/api/cron/'];

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(self)',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export const onRequest = defineMiddleware(async (context, next) => {
  const runtime = (
    context.locals as { runtime?: { env: Env; ctx?: { waitUntil?: (p: Promise<unknown>) => void } } }
  ).runtime;

  // Prerender pass (build time) or a static asset: nothing to attach.
  if (!runtime?.env?.DB) {
    return next();
  }

  const env = runtime.env;
  const requestId = crypto.randomUUID();
  const url = new URL(context.request.url);
  const waitUntil = runtime.ctx?.waitUntil ? runtime.ctx.waitUntil.bind(runtime.ctx) : undefined;
  const ctx = new AppContext(env, url, clientIp(context.request), requestId, waitUntil);

  try {
    const sessionToken = context.cookies.get(SESSION_COOKIE)?.value;
    if (sessionToken) {
      const resolved = await resolveSession(ctx.db, sessionToken);
      if (resolved) {
        ctx.user = resolved.user;
        ctx.sessionId = resolved.sessionId;
      } else {
        // Stale or revoked cookie — clear it so the browser stops sending it.
        context.cookies.delete(SESSION_COOKIE, { path: '/' });
      }
    }

    ctx.cartId = context.cookies.get(CART_COOKIE)?.value ?? null;
    ctx.csrfToken = await ensureCsrfToken(context.cookies, env);

    const isExempt = CSRF_EXEMPT_PREFIXES.some((p) => url.pathname.startsWith(p));
    if (!isExempt) {
      await assertCsrf(context.request, context.cookies, env);
    }
  } catch (err) {
    // A CSRF rejection is the expected throw here; anything else is a bug worth
    // seeing. Both become a proper response rather than a blank 500.
    log.warn('middleware.rejected', { path: url.pathname, error: errMessage(err) });
    if (url.pathname.startsWith('/api/')) return withSecurityHeaders(fail(err), url);
    return withSecurityHeaders(
      new Response('Your session expired. Please go back, refresh the page, and try again.', {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }),
      url,
    );
  }

  context.locals.ctx = ctx;
  context.locals.user = ctx.user;
  context.locals.csrfToken = ctx.csrfToken;

  const started = Date.now();
  const response = await next();

  log.info('request', {
    requestId,
    method: context.request.method,
    path: url.pathname,
    status: response.status,
    ms: Date.now() - started,
    userId: ctx.user?.id ?? null,
  });

  return withSecurityHeaders(response, url);
});

function withSecurityHeaders(response: Response, url: URL): Response {
  // Response headers are immutable on some paths (e.g. redirects produced by
  // Astro); clone before mutating rather than throwing.
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);

  // Anything under an authenticated area must not be cached by an intermediary.
  if (
    url.pathname.startsWith('/account') ||
    url.pathname.startsWith('/admin') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/checkout')
  ) {
    headers.set('Cache-Control', 'no-store, must-revalidate');
  }

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
