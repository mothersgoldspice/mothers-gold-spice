/**
 * Password reset — request a link (POST) and consume it (PUT).
 *
 * The request path ALWAYS reports success, whether or not the address exists.
 * Anything else turns this form into a "does this person shop here?" oracle.
 */

import type { APIRoute } from 'astro';
import { rateKey, requireCtx } from '../../../lib/api';
import { revokeAllSessions, startSession } from '../../../lib/auth/session';
import { siteUrl } from '../../../lib/env';
import { handle, ok, readJson } from '../../../lib/http';
import { log, maskEmail } from '../../../lib/log';
import { passwordChanged, passwordReset, storeContext } from '../../../lib/providers/email/templates';
import { RATE_LIMITS, enforceRateLimit } from '../../../lib/rate-limit';
import {
  PASSWORD_RESET_TTL_MS,
  consumeToken,
  findUserByEmail,
  findUserById,
  issueToken,
  markEmailVerified,
  setPassword,
} from '../../../lib/services/accounts';
import { queueAndSend } from '../../../lib/services/notify';
import { parseOrThrow, passwordResetRequestSchema, passwordResetSchema } from '../../../lib/validate';

export const prerender = false;

/** Request a reset link. */
export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    const input = parseOrThrow(passwordResetRequestSchema, await readJson(request));
    await enforceRateLimit(ctx.db, rateKey(ctx, 'pwreset'), RATE_LIMITS.passwordReset);
    await enforceRateLimit(ctx.db, `pwreset:acct:${input.email}`, RATE_LIMITS.passwordReset);

    const user = await findUserByEmail(ctx.db, input.email);
    if (user && user.status === 'active') {
      const token = await issueToken(ctx.db, {
        userId: user.id,
        purpose: 'password_reset',
        email: user.email,
        ttlMs: PASSWORD_RESET_TTL_MS,
      });
      const mail = passwordReset({
        store: storeContext(ctx.env),
        name: user.name || 'there',
        resetUrl: `${siteUrl(ctx.env)}/account/reset?token=${encodeURIComponent(token)}`,
        expiresAt: Date.now() + PASSWORD_RESET_TTL_MS,
      });
      await queueAndSend(ctx, {
        to: user.email,
        toName: user.name,
        subject: mail.subject,
        template: mail.template,
        text: mail.text,
        html: mail.html,
        userId: user.id,
        idempotencyKey: `pwreset:${user.id}:${Math.floor(Date.now() / 60000)}`,
      });
    } else {
      log.info('auth.reset_requested_unknown', { email: maskEmail(input.email) });
    }

    return ok({ sent: true });
  });

/** Consume the link and set the new password. */
export const PUT: APIRoute = async ({ locals, request, cookies }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    const input = parseOrThrow(passwordResetSchema, await readJson(request));

    const token = await consumeToken(ctx.db, input.token, 'password_reset');
    if (!token.user_id) throw new Error('Password reset token has no user attached');

    await setPassword(ctx.db, token.user_id, input.password);
    // Clicking a link sent to the address proves control of it.
    await markEmailVerified(ctx.db, token.user_id);

    // Whoever knew the old password is signed out everywhere — that is the point
    // of a reset when the account may have been compromised.
    const revoked = await revokeAllSessions(ctx.db, token.user_id);

    const user = await findUserById(ctx.db, token.user_id);
    if (user) {
      const mail = passwordChanged({
        store: storeContext(ctx.env),
        name: user.name || 'there',
        changedAt: Date.now(),
        ip: ctx.clientIp,
        device: request.headers.get('user-agent'),
      });
      await queueAndSend(ctx, {
        to: user.email,
        toName: user.name,
        subject: mail.subject,
        template: mail.template,
        text: mail.text,
        html: mail.html,
        userId: user.id,
        idempotencyKey: `pwchanged:${user.id}:${Math.floor(Date.now() / 60000)}`,
      });

      await startSession(ctx.db, cookies, ctx.env, {
        userId: user.id,
        ip: ctx.clientIp,
        userAgent: request.headers.get('user-agent') ?? '',
      });
    }

    log.info('auth.password_reset_completed', { userId: token.user_id, sessionsRevoked: revoked });
    return ok({ reset: true });
  });
