/**
 * Start paying for an order that was placed but never paid for.
 *
 * A failed card, a closed browser tab, a UPI app that never came back — the
 * order exists, its stock is still reserved and its total is fixed. This mints a
 * fresh gateway session against that same order rather than making the customer
 * rebuild a basket that was already converted.
 *
 * Nothing about the order is recomputed here: `startPayment` charges
 * `order.total_paise`, and it reuses an existing pending session rather than
 * opening a second one for the same money.
 */

import type { APIRoute } from 'astro';
import { rateKey, requireCtx } from '../../../lib/api';
import { badRequest, notFound } from '../../../lib/errors';
import { handle, ok, readJson } from '../../../lib/http';
import { log } from '../../../lib/log';
import { RATE_LIMITS, enforceRateLimit } from '../../../lib/rate-limit';
import { assertOrderAccess, getOrderById } from '../../../lib/services/orders';
import { startPayment } from '../../../lib/services/payments';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request, url }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    await enforceRateLimit(ctx.db, rateKey(ctx, 'checkout-retry'), RATE_LIMITS.checkout);

    const body = await readJson<{ order_id?: unknown; t?: unknown }>(request);
    const orderId = typeof body.order_id === 'string' ? body.order_id.trim() : '';
    if (!orderId) throw badRequest('Missing order reference.');

    const order = await getOrderById(ctx.db, orderId);
    if (!order) throw notFound('We could not find that order.');

    // A guest proves ownership with the derived token from their email, which
    // may arrive in the body or on the query string depending on the caller.
    const guestToken = typeof body.t === 'string' ? body.t : url.searchParams.get('t');
    await assertOrderAccess(ctx, order, guestToken);

    // Deliberately no `storeOpen` check. The order already exists and its jars
    // are already held; refusing the payment because the shop is between batches
    // would strand a customer who owes us money and wants to pay it.
    const payment = await startPayment(ctx, order);

    log.info('checkout.retry_started', { orderId: order.id, provider: payment.provider });

    return ok({
      orderId: order.id,
      orderNumber: order.order_number,
      provider: payment.provider,
      checkoutUrl: payment.checkoutUrl,
    });
  });
