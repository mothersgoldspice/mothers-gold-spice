/**
 * Liveness and configuration check.
 *
 * Reports which provider each seam actually resolved to, so "why did no email
 * arrive?" is one request away from an answer. Deliberately does NOT call the
 * providers' healthCheck() by default — that would make an uptime probe issue
 * outbound API calls every minute. Pass `?deep=1` (staff only) for that.
 */

import type { APIRoute } from 'astro';
import { requireCtx } from '../../lib/api';
import { appEnv, mocksAllowed } from '../../lib/env';
import { handle, ok } from '../../lib/http';
import { errMessage } from '../../lib/log';

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) =>
  handle(async () => {
    const ctx = requireCtx(locals);

    let database = 'ok';
    try {
      await ctx.db.scalar<number>('SELECT 1');
    } catch (err) {
      database = errMessage(err);
    }

    const body: Record<string, unknown> = {
      status: database === 'ok' ? 'ok' : 'degraded',
      env: appEnv(ctx.env),
      database,
      providers: {
        email: ctx.email.name,
        payment: ctx.payment.name,
        shipping: ctx.shipping.name,
      },
      mocksAllowed: mocksAllowed(ctx.env),
      time: new Date().toISOString(),
    };

    if (url.searchParams.get('deep') === '1' && ctx.isAdmin) {
      body.deep = {
        email: await ctx.email.healthCheck(),
        payment: await ctx.payment.healthCheck(),
        shipping: await ctx.shipping.healthCheck(),
      };
    }

    return ok(body);
  });
