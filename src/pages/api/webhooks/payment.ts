/**
 * Payment provider callback.
 *
 * Exempt from CSRF (see src/middleware.ts) because a gateway has no cookie and
 * no same-site origin. Authenticity comes from the provider's signature instead,
 * verified inside the adapter — which is a stronger check than a CSRF token,
 * not a weaker one.
 *
 * Always answers 200 once the event has been RECORDED, even if applying it
 * failed. A provider that receives a 500 retries with exponential backoff and
 * eventually gives up; recording first and reporting success means a failed
 * application is a row an operator can replay, not a payment we never hear
 * about again. Signature failures are the exception — those get 401 so a
 * misconfigured secret is loud.
 */

import type { APIRoute } from 'astro';
import { requireCtx } from '../../../lib/api';
import { handle, ok } from '../../../lib/http';
import { errMessage, log } from '../../../lib/log';
import { handlePaymentWebhook } from '../../../lib/services/payments';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const ctx = requireCtx(locals);

    // The body must be read as raw text and hashed byte-for-byte — parsing and
    // re-serialising would change it and every signature would fail.
    const rawBody = await request.text();

    let event;
    try {
      event = await ctx.payment.verifyAndParseWebhook(rawBody, request.headers);
    } catch (err) {
      log.alert('webhook.payment.signature_rejected', {
        provider: ctx.payment.name,
        error: errMessage(err),
        alertKey: 'payment_webhook_signature_failed',
      });
      return new Response(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: 'Invalid signature.' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const result = await handlePaymentWebhook(ctx, event, true);
      log.info('webhook.payment.handled', {
        provider: ctx.payment.name,
        type: event.providerEventName,
        outcome: result.outcome,
        orderId: result.orderId,
      });
      return ok({ received: true, outcome: result.outcome });
    } catch (err) {
      // Recorded but not applied. Answer 200 so the provider stops retrying, and
      // rely on the failed `webhook_events` row plus the alert for recovery.
      log.alert('webhook.payment.apply_failed', {
        provider: ctx.payment.name,
        eventId: event.eventId,
        type: event.providerEventName,
        error: errMessage(err),
        alertKey: 'payment_webhook_apply_failed',
      });
      return ok({ received: true, outcome: 'failed' });
    }
  });
