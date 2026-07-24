/**
 * Consume an email-verification link, and resend one.
 *
 * Verification does not gate ordering — it gates the "verified" state and
 * marketing consent. Blocking checkout on it would cost more orders than the
 * fraud it prevents at this scale.
 */

import type { APIRoute } from 'astro';
import { rateKey, requireCtx, requireUser } from '../../../lib/api';
import { siteUrl } from '../../../lib/env';
import { badRequest } from '../../../lib/errors';
import { handle, ok, readJson } from '../../../lib/http';
import { storeContext, verifyEmail, welcome } from '../../../lib/providers/email/templates';
import { RATE_LIMITS, enforceRateLimit } from '../../../lib/rate-limit';
import { EMAIL_VERIFY_TTL_MS, consumeToken, findUserById, issueToken, markEmailVerified } from '../../../lib/services/accounts';
import { queueAndSend } from '../../../lib/services/notify';

export const prerender = false;

/** Consume a token. */
export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    const body = await readJson<{ token?: string }>(request);
    const raw = (body.token ?? '').trim();
    if (!raw) throw badRequest('That verification link is not valid.');

    const token = await consumeToken(ctx.db, raw, 'email_verify');
    if (!token.user_id) throw badRequest('That verification link is not valid.');

    await markEmailVerified(ctx.db, token.user_id);
    const user = await findUserById(ctx.db, token.user_id);

    if (user) {
      const mail = welcome({
        store: storeContext(ctx.env),
        name: user.name || 'there',
        shopUrl: `${siteUrl(ctx.env)}/shop`,
      });
      await queueAndSend(ctx, {
        to: user.email,
        toName: user.name,
        subject: mail.subject,
        template: mail.template,
        text: mail.text,
        html: mail.html,
        userId: user.id,
        // One welcome per account, ever.
        idempotencyKey: `welcome:${user.id}`,
      });
    }

    return ok({ verified: true });
  });

/** Resend the verification email to the signed-in customer. */
export const PUT: APIRoute = async ({ locals }) =>
  handle(async () => {
    const { ctx, user } = requireUser(locals);
    if (user.emailVerified) return ok({ alreadyVerified: true });

    await enforceRateLimit(ctx.db, rateKey(ctx, 'verify_resend'), RATE_LIMITS.passwordReset);

    const token = await issueToken(ctx.db, {
      userId: user.id,
      purpose: 'email_verify',
      email: user.email,
      ttlMs: EMAIL_VERIFY_TTL_MS,
    });
    const mail = verifyEmail({
      store: storeContext(ctx.env),
      name: user.name || 'there',
      verifyUrl: `${siteUrl(ctx.env)}/account/verify?token=${encodeURIComponent(token)}`,
      expiresAt: Date.now() + EMAIL_VERIFY_TTL_MS,
    });
    await queueAndSend(ctx, {
      to: user.email,
      toName: user.name,
      subject: mail.subject,
      template: mail.template,
      text: mail.text,
      html: mail.html,
      userId: user.id,
      idempotencyKey: `verify:${user.id}:${Math.floor(Date.now() / 60000)}`,
    });

    return ok({ sent: true });
  });
