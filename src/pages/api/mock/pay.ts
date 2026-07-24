/**
 * The mock gateway's "customer pressed the button" endpoint.
 *
 * Called by /checkout/pay/[id], the simulated hosted checkout page. It advances
 * the fake transaction and produces the signed webhook a real gateway would
 * have POSTed, then delivers it.
 *
 * ─── On how it is delivered ──────────────────────────────────────────────────
 *
 * Delivering over real HTTP is preferable, because handing the event straight to
 * the handler skips routing, the middleware's CSRF exemption and the request
 * plumbing — the parts most likely to be misconfigured when real credentials
 * land. That works in local development.
 *
 * It cannot work on Cloudflare: a Worker is not allowed to make a subrequest to
 * its own hostname, and the attempt fails with error 1042. So in production this
 * falls back to invoking the handler in-process. The signature is STILL verified
 * by `verifyAndParseWebhook` on that path — only the transport differs.
 *
 * `deliver: false` returns the prepared, signed payload without delivering it,
 * which lets an external caller (scripts/smoke-test.mjs) POST it to
 * /api/webhooks/payment itself. That is how the deployed webhook route gets
 * exercised over genuine HTTP despite the self-subrequest ban.
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

    const body = await readJson<{
      transaction_id?: string;
      outcome?: string;
      method?: string;
      deliver?: boolean;
    }>(request);
    const transactionId = (body.transaction_id ?? '').trim();
    const outcome = body.outcome === 'failure' ? 'failure' : body.outcome === 'cancel' ? 'cancel' : 'success';
    if (!transactionId) throw badRequest('transaction_id is required.');

    // An unknown transaction id is a bad request, not a server fault — without
    // this the simulator answers 500 for a mistyped URL and the checkout page
    // shows "something went wrong on our side" for something that was not.
    const known = await provider.loadTransaction(transactionId);
    if (!known) throw notFound('That payment session does not exist or has expired.');

    const simulated = await provider.simulate(transactionId, outcome, body.method ?? 'upi');

    if (body.deliver === false) {
      return ok({
        simulated: outcome,
        transactionId,
        orderId: simulated.transaction.orderId,
        status: simulated.transaction.status,
        delivered: false,
        // The caller delivers this to /api/webhooks/payment itself.
        webhook: {
          url: '/api/webhooks/payment',
          headerName: simulated.headerName,
          signatureHeader: simulated.signatureHeader,
          body: simulated.body,
        },
        redirectUrl: `/checkout/return?order=${encodeURIComponent(simulated.transaction.orderId)}`,
      });
    }

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
      // Expected on Cloudflare, where a Worker may not call its own hostname.
      // Invoke the handler directly — the signature is still verified below, so
      // only the transport is skipped. Logged at info rather than warn because
      // in production this is the normal path, not a fault.
      log.info('mock.webhook_delivered_in_process', { webhookUrl, detail: deliveryDetail });
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
