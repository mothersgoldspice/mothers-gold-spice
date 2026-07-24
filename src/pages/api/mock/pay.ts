/**
 * The mock gateway's "customer pressed the button" endpoint.
 *
 * Called by /checkout/pay/[id], the simulated hosted checkout page. It advances
 * the fake transaction and then delivers the resulting signed webhook over a
 * real HTTP request to our own /api/webhooks/payment.
 *
 * The self-request is the point. Handing the event straight to the handler would
 * skip routing, the middleware's CSRF exemption and signature verification —
 * exactly the parts most likely to be misconfigured when real credentials land.
 * Going over the wire means the confirmation path proven here is the same one
 * Paddle or Razorpay will drive in production.
 *
 * Only reachable while PAYMENT_PROVIDER is mock; on a real gateway it 404s.
 */

import type { APIRoute } from 'astro';
import { requireCtx } from '../../../lib/api';
import { siteUrl } from '../../../lib/env';
import { badRequest, notFound } from '../../../lib/errors';
import { handle, ok, readJson } from '../../../lib/http';
import { errMessage, log } from '../../../lib/log';
import { MockPaymentProvider } from '../../../lib/providers/payment/mock';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    const provider = ctx.payment;
    if (!(provider instanceof MockPaymentProvider)) throw notFound();

    const body = await readJson<{ transaction_id?: string; outcome?: string; method?: string }>(request);
    const transactionId = (body.transaction_id ?? '').trim();
    const outcome = body.outcome === 'failure' ? 'failure' : body.outcome === 'cancel' ? 'cancel' : 'success';
    if (!transactionId) throw badRequest('transaction_id is required.');

    const simulated = await provider.simulate(transactionId, outcome, body.method ?? 'upi');

    const webhookUrl = `${siteUrl(ctx.env)}/api/webhooks/payment`;
    let delivered = false;
    let deliveryDetail = '';

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [simulated.headerName]: simulated.signatureHeader,
        },
        body: simulated.body,
      });
      delivered = res.ok;
      deliveryDetail = `${res.status} ${(await res.text()).slice(0, 200)}`;
    } catch (err) {
      deliveryDetail = errMessage(err);
    }

    if (!delivered) {
      // The site URL may not be reachable from inside the Worker (local dev
      // behind a proxy, a misconfigured PUBLIC_SITE_URL). Fall back to invoking
      // the handler in-process so the simulator still works, and say so plainly
      // rather than pretending the round trip succeeded.
      log.warn('mock.webhook_self_delivery_failed', { webhookUrl, detail: deliveryDetail });
      const { handlePaymentWebhook } = await import('../../../lib/services/payments');
      const event = await provider.verifyAndParseWebhook(
        simulated.body,
        new Headers({ [simulated.headerName]: simulated.signatureHeader }),
      );
      await handlePaymentWebhook(ctx, event, true);
    }

    return ok({
      simulated: outcome,
      transactionId,
      orderId: simulated.transaction.orderId,
      status: simulated.transaction.status,
      webhookDeliveredOverHttp: delivered,
      redirectUrl: `/checkout/return?order=${encodeURIComponent(simulated.transaction.orderId)}`,
    });
  });
