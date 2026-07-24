/**
 * Create an account.
 *
 * The response is identical whether the address was free or already taken. A
 * taken address gets a "someone tried to sign up as you" email to the real
 * owner instead of an error to the caller, so this endpoint cannot be used to
 * enumerate our customers.
 */

import type { APIRoute } from 'astro';
import { rateKey, requireCtx } from '../../../lib/api';
import { startSession } from '../../../lib/auth/session';
import { handle, ok, readJson } from '../../../lib/http';
import { log, maskEmail } from '../../../lib/log';
import { RATE_LIMITS, enforceRateLimit } from '../../../lib/rate-limit';
import { EMAIL_VERIFY_TTL_MS, registerUser } from '../../../lib/services/accounts';
import { mergeCarts } from '../../../lib/services/cart';
import { queueAndSend } from '../../../lib/services/notify';
import { siteUrl } from '../../../lib/env';
import { passwordReset, storeContext, verifyEmail } from '../../../lib/providers/email/templates';
import { parseOrThrow, registerSchema } from '../../../lib/validate';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request, cookies }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    await enforceRateLimit(ctx.db, rateKey(ctx, 'register'), RATE_LIMITS.register);

    const input = parseOrThrow(registerSchema, await readJson(request));
    const settings = await ctx.settings();
    const outcome = await registerUser(ctx.db, {
      name: input.name,
      email: input.email,
      password: input.password,
      phone: input.phone,
      marketingOptIn: input.marketing_opt_in,
    });

    if (!outcome.created) {
      // Tell the real owner, not the caller. If it was them, the reset link is
      // exactly what they need; if it was not, they learn someone tried.
      const token = await import('../../../lib/services/accounts').then((m) =>
        m.issueToken(ctx.db, {
          userId: outcome.existingUser.id,
          purpose: 'password_reset',
          email: outcome.existingUser.email,
          ttlMs: 60 * 60 * 1000,
        }),
      );
      const mail = passwordReset({
        store: storeContext(ctx.env),
        name: outcome.existingUser.name || 'there',
        resetUrl: `${siteUrl(ctx.env)}/account/reset?token=${encodeURIComponent(token)}`,
        expiresAt: Date.now() + 60 * 60 * 1000,
      });
      await queueAndSend(ctx, {
        to: outcome.existingUser.email,
        toName: outcome.existingUser.name,
        subject: mail.subject,
        template: mail.template,
        text: mail.text,
        html: mail.html,
        userId: outcome.existingUser.id,
        idempotencyKey: `signup_collision:${outcome.existingUser.id}:${Math.floor(Date.now() / 3600000)}`,
      });
      log.info('auth.register_collision', { email: maskEmail(input.email) });

      return ok({ registered: true, verificationSent: true });
    }

    const mail = verifyEmail({
      store: storeContext(ctx.env),
      name: outcome.user.name || 'there',
      verifyUrl: `${siteUrl(ctx.env)}/account/verify?token=${encodeURIComponent(outcome.verificationToken)}`,
      expiresAt: Date.now() + EMAIL_VERIFY_TTL_MS,
    });
    await queueAndSend(ctx, {
      to: outcome.user.email,
      toName: outcome.user.name,
      subject: mail.subject,
      template: mail.template,
      text: mail.text,
      html: mail.html,
      userId: outcome.user.id,
      idempotencyKey: `verify:${outcome.user.id}:${Math.floor(Date.now() / 60000)}`,
    });

    // Sign them straight in. Requiring verification before the first order would
    // cost more sales than it prevents fraud at this scale; verification gates
    // nothing except the "verified" badge and marketing consent.
    await startSession(ctx.db, cookies, ctx.env, {
      userId: outcome.user.id,
      ip: ctx.clientIp,
      userAgent: request.headers.get('user-agent') ?? '',
    });

    if (ctx.cartId) {
      const merged = await mergeCarts(ctx.db, ctx.cartId, outcome.user.id, settings);
      if (merged !== ctx.cartId) {
        cookies.set('mgs_cart', merged, { path: '/', httpOnly: true, sameSite: 'lax' });
      }
    }

    return ok({ registered: true, verificationSent: true, user: { name: outcome.user.name, email: outcome.user.email } });
  });
