/**
 * Courier tracking callback.
 *
 * Same contract as the payment webhook: signature (or shared token) verified in
 * the adapter, event recorded before it is applied, 200 once recorded.
 *
 * Couriers are chatty and unreliable about ordering — the same scan arrives
 * repeatedly and "delivered" sometimes lands before "out for delivery". Dedupe
 * is a UNIQUE constraint on the event, and ordering is handled by the order
 * state machine refusing to move backwards.
 */

import type { APIRoute } from 'astro';
import { requireCtx } from '../../../lib/api';
import { handle, ok } from '../../../lib/http';
import { errMessage, log } from '../../../lib/log';
import { handleShipmentWebhook } from '../../../lib/services/shipments';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    const rawBody = await request.text();

    let event;
    try {
      event = await ctx.shipping.verifyAndParseWebhook(rawBody, request.headers);
    } catch (err) {
      log.alert('webhook.shipping.signature_rejected', {
        provider: ctx.shipping.name,
        error: errMessage(err),
        alertKey: 'shipping_webhook_signature_failed',
      });
      return new Response(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'Invalid signature.' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const result = await handleShipmentWebhook(ctx, event);
      log.info('webhook.shipping.handled', {
        provider: ctx.shipping.name,
        status: event.status,
        outcome: result.outcome,
        orderId: result.orderId,
      });
      return ok({ received: true, outcome: result.outcome });
    } catch (err) {
      log.alert('webhook.shipping.apply_failed', {
        provider: ctx.shipping.name,
        eventId: event.eventId,
        error: errMessage(err),
        alertKey: 'shipping_webhook_apply_failed',
      });
      return ok({ received: true, outcome: 'failed' });
    }
  });
