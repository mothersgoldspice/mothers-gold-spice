/**
 * Newsletter sign-up from the footer.
 *
 * The answer is the same whether the address is new, already subscribed, or had
 * unsubscribed. Anything else turns a public form into a "does this person shop
 * here?" oracle, exactly as with password reset.
 */

import type { APIRoute } from 'astro';
import { rateKey, requireCtx } from '../../lib/api';
import { handle, ok, readJson } from '../../lib/http';
import { newId } from '../../lib/ids';
import { log, maskEmail } from '../../lib/log';
import { RATE_LIMITS, enforceRateLimit } from '../../lib/rate-limit';
import { newsletterSchema, parseOrThrow } from '../../lib/validate';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    const input = parseOrThrow(newsletterSchema, await readJson(request));
    await enforceRateLimit(ctx.db, rateKey(ctx, 'newsletter'), RATE_LIMITS.contact);

    // Re-subscribing is allowed: someone typing their address into the form is
    // asking to be added back. It cannot be used to force mail onto a person who
    // bounced or complained — `email_suppressions` is checked again at send time,
    // so a suppressed address stays unmailed however this row reads.
    await ctx.db.run(
      `INSERT INTO newsletter_subscribers (id, email, status, source, created_at)
       VALUES (?, ?, 'subscribed', ?, ?)
       ON CONFLICT (email) DO UPDATE SET status = 'subscribed', unsubscribed_at = NULL`,
      [newId('sub'), input.email, input.source, Date.now()],
    );

    log.info('newsletter.subscribed', { email: maskEmail(input.email), source: input.source });
    return ok({ subscribed: true });
  });
