/**
 * Change the password of the signed-in account.
 *
 * The current password is re-verified even though the caller already holds a
 * session: a laptop left open in a hostel is the ordinary case, and knowing the
 * old password is what separates the owner from whoever sat down after them.
 */

import type { APIRoute } from 'astro';
import { rateKey, requireUser } from '../../../lib/api';
import { revokeAllSessions } from '../../../lib/auth/session';
import { badRequest, isAppError } from '../../../lib/errors';
import { handle, ok, readJson } from '../../../lib/http';
import { log } from '../../../lib/log';
import { passwordChanged, storeContext } from '../../../lib/providers/email/templates';
import { RATE_LIMITS, enforceRateLimit } from '../../../lib/rate-limit';
import { authenticate, setPassword } from '../../../lib/services/accounts';
import { queueAndSend } from '../../../lib/services/notify';
import { parseOrThrow, passwordChangeSchema } from '../../../lib/validate';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireUser(locals);
    const input = parseOrThrow(passwordChangeSchema, await readJson(request));

    // Same budget as a password reset: this is the other way to take an account
    // over, so it deserves the same ceiling on guesses.
    await enforceRateLimit(ctx.db, rateKey(ctx, 'pwchange'), RATE_LIMITS.passwordReset);

    try {
      await authenticate(ctx.db, user.email, input.current_password);
    } catch (err) {
      // `authenticate` words its failure for the sign-in form, where naming the
      // wrong field would confirm which addresses are registered. Here the
      // customer is already signed in, so there is nothing left to hide and the
      // only useful answer is which field to fix.
      if (isAppError(err) && err.code === 'unauthorized') {
        throw badRequest('That is not your current password. Please try again.');
      }
      throw err;
    }

    await setPassword(ctx.db, user.id, input.password);

    // Every OTHER device is signed out. If the password is being changed because
    // it leaked, leaving the sessions it created alive would defeat the change.
    // This session is spared so the customer is not thrown off the page they are
    // standing on.
    const revoked = await revokeAllSessions(ctx.db, user.id, ctx.sessionId ?? undefined);

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
      // Per-minute key: a genuine second change an hour later must still be
      // announced, but a double-submitted form must not send two warnings.
      idempotencyKey: `pwchanged:${user.id}:${Math.floor(Date.now() / 60000)}`,
    });

    log.info('account.password_changed', { userId: user.id, sessionsRevoked: revoked });
    return ok({ changed: true, otherDevicesSignedOut: revoked });
  });
