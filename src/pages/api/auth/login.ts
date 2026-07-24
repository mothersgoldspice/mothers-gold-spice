/**
 * Sign in.
 *
 * The anonymous cart is merged into the customer's cart on success, so adding a
 * jar and then logging in does not lose the jar.
 */

import type { APIRoute } from 'astro';
import { rateKey, requireCtx } from '../../../lib/api';
import { CART_COOKIE, CART_TTL_MS, setCookie } from '../../../lib/auth/cookies';
import { startSession } from '../../../lib/auth/session';
import { handle, ok, readJson } from '../../../lib/http';
import { log, maskEmail } from '../../../lib/log';
import { RATE_LIMITS, enforceRateLimit } from '../../../lib/rate-limit';
import { authenticate } from '../../../lib/services/accounts';
import { mergeCarts } from '../../../lib/services/cart';
import { loginSchema, parseOrThrow } from '../../../lib/validate';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request, cookies }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    const input = parseOrThrow(loginSchema, await readJson(request));

    // Limit by IP AND by the address being targeted, so one attacker cannot work
    // through many accounts from one address, nor many addresses at one account.
    await enforceRateLimit(ctx.db, rateKey(ctx, 'login'), RATE_LIMITS.login);
    await enforceRateLimit(ctx.db, `login:acct:${input.email}`, RATE_LIMITS.login);

    const { user } = await authenticate(ctx.db, input.email, input.password);

    await startSession(ctx.db, cookies, ctx.env, {
      userId: user.id,
      ip: ctx.clientIp,
      userAgent: request.headers.get('user-agent') ?? '',
    });

    if (ctx.cartId) {
      const settings = await ctx.settings();
      const merged = await mergeCarts(ctx.db, ctx.cartId, user.id, settings);
      if (merged !== ctx.cartId) setCookie(cookies, ctx.env, CART_COOKIE, merged, CART_TTL_MS);
    }

    log.info('auth.login', { userId: user.id, email: maskEmail(user.email) });
    return ok({
      user: { name: user.name, email: user.email, role: user.role, emailVerified: user.email_verified_at !== null },
    });
  });
