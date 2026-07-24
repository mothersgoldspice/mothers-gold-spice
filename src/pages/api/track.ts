/**
 * Guest order lookup: order number plus the email address it was placed with.
 *
 * The pair is checked as a pair, and a mismatch is reported with one message
 * whatever went wrong. That is deliberate: order numbers run in sequence, so an
 * endpoint that distinguished "no such order" from "wrong email" would let
 * anyone walk MGS-26-0001 upwards and learn exactly how many orders we have
 * taken — and, with a guessed email, read a stranger's address.
 *
 * Success returns the tracking URL carrying the derived access token, which is
 * the same link the customer's confirmation email contains.
 *
 * Both an HTML form post and a JSON fetch are accepted. The form path answers
 * with a redirect so the tracking page works with JavaScript switched off.
 */

import type { APIRoute } from 'astro';
import { rateKey, readInput, requireCtx } from '../../lib/api';
import { notFound } from '../../lib/errors';
import { handle, ok, redirect } from '../../lib/http';
import { log, maskEmail } from '../../lib/log';
import { RATE_LIMITS, enforceRateLimit } from '../../lib/rate-limit';
import { getOrderByNumber, guestAccessToken } from '../../lib/services/orders';
import { emailSchema, parseOrThrow } from '../../lib/validate';

export const prerender = false;

/** One wording for every failure, so nothing is revealed by which one you get. */
const GENERIC_FAILURE = 'We could not find an order with that number and email address.';

export const POST: APIRoute = async (context) =>
  handle(async () => {
    const ctx = requireCtx(context.locals);
    const isFormPost = (context.request.headers.get('content-type') ?? '').includes('form');

    // A guessing loop has to be expensive: the token behind this lookup is what
    // guards somebody's home address and phone number.
    try {
      await enforceRateLimit(ctx.db, rateKey(ctx, 'guest-track'), RATE_LIMITS.guestTrack);
    } catch (err) {
      if (isFormPost) return redirect('/track?e=rate');
      throw err;
    }

    const input = await readInput(context);
    const orderNumber = String(input['order_number'] ?? '')
      .trim()
      .toUpperCase();

    const fail = () => {
      log.info('track.lookup_failed', { orderNumber: orderNumber.slice(0, 20) });
      if (isFormPost) return redirect('/track?e=1');
      throw notFound(GENERIC_FAILURE);
    };

    if (orderNumber.length < 3 || orderNumber.length > 40) return fail();

    let email: string;
    try {
      email = parseOrThrow(emailSchema, input['email']);
    } catch {
      // Even "that is not an email address" is withheld — one answer, always.
      return fail();
    }

    const order = await getOrderByNumber(ctx.db, orderNumber);
    if (!order || order.email !== email) return fail();

    const token = await guestAccessToken(ctx.env, order.id);
    const trackingUrl = `/track/${order.id}?t=${encodeURIComponent(token)}`;

    log.info('track.lookup_succeeded', { orderId: order.id, email: maskEmail(email) });

    if (isFormPost) return redirect(trackingUrl);
    return ok({ trackingUrl });
  });
