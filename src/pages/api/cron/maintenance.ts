/**
 * Scheduled housekeeping.
 *
 * Four jobs that all matter but none of which belong on a request path:
 *   1. drain the email outbox (retry anything a provider blip failed)
 *   2. expire stock reservations from abandoned checkouts
 *   3. abandon stale carts
 *   4. prune expired sessions, tokens and rate-limit windows
 *
 * Authenticated by a bearer secret rather than a session, because the caller is
 * a scheduler and not a person. CSRF-exempt for the same reason. Every job runs
 * independently — one failure must not stop the others, or a single bad email
 * would also stop stock from ever being released.
 */

import type { APIRoute } from 'astro';
import { requireCtx } from '../../../lib/api';
import { pruneExpiredTokens } from '../../../lib/services/accounts';
import { pruneExpiredSessions } from '../../../lib/auth/session';
import { optionalEnv } from '../../../lib/env';
import { handle, ok } from '../../../lib/http';
import { errMessage, log } from '../../../lib/log';
import { pruneRateLimits } from '../../../lib/rate-limit';
import { pruneExpiredCarts } from '../../../lib/services/cart';
import { dispatchOutbox } from '../../../lib/services/notify';
import { expireStaleReservations } from '../../../lib/services/orders';
import { timingSafeEqual } from '../../../lib/crypto';

export const prerender = false;

async function runJob<T>(name: string, fn: () => Promise<T>): Promise<{ job: string; ok: boolean; result?: T; error?: string }> {
  try {
    return { job: name, ok: true, result: await fn() };
  } catch (err) {
    log.error('cron.job_failed', { job: name, error: errMessage(err) });
    return { job: name, ok: false, error: errMessage(err) };
  }
}

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const ctx = requireCtx(locals);

    const secret = optionalEnv(ctx.env, 'CRON_SECRET');
    const presented = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!secret || !presented || !timingSafeEqual(secret, presented)) {
      log.warn('cron.unauthorised', { ip: ctx.clientIp });
      return new Response(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'Not authorised.' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const started = Date.now();
    const results = [
      await runJob('email_outbox', () => dispatchOutbox(ctx.db, ctx.email, 25)),
      await runJob('expire_reservations', () => expireStaleReservations(ctx.db, 50)),
      await runJob('abandon_carts', () => pruneExpiredCarts(ctx.db)),
      await runJob('prune_sessions', () => pruneExpiredSessions(ctx.db)),
      await runJob('prune_tokens', () => pruneExpiredTokens(ctx.db)),
      await runJob('prune_rate_limits', () => pruneRateLimits(ctx.db)),
    ];

    log.info('cron.completed', { ms: Date.now() - started, failed: results.filter((r) => !r.ok).length });
    return ok({ ranAt: started, ms: Date.now() - started, jobs: results });
  });
