/**
 * Move a simulated parcel one scan forward.
 *
 * Staff-only, and only while SHIPPING_PROVIDER is mock. Like the payment
 * simulator it delivers a genuinely signed webhook to our own endpoint, so the
 * tracking pipeline being exercised is the production one.
 */

import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/api';
import { siteUrl } from '../../../lib/env';
import { badRequest, notFound } from '../../../lib/errors';
import { handle, ok, readJson } from '../../../lib/http';
import { errMessage, log } from '../../../lib/log';
import { MockShipmentProvider } from '../../../lib/providers/shipping/mock';
import type { TrackingStatus } from '../../../lib/providers/shipping/types';
import { handleShipmentWebhook } from '../../../lib/services/shipments';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx } = requireAdmin(locals);
    const provider = ctx.shipping;
    if (!(provider instanceof MockShipmentProvider)) throw notFound();

    const body = await readJson<{ provider_shipment_id?: string; to?: TrackingStatus }>(request);
    const providerShipmentId = (body.provider_shipment_id ?? '').trim();
    if (!providerShipmentId) throw badRequest('provider_shipment_id is required.');

    const advanced = await provider.advance(providerShipmentId, body.to);
    if (!advanced) return ok({ advanced: false, reason: 'Parcel is already in a terminal state.' });

    let delivered = false;
    try {
      const res = await fetch(`${siteUrl(ctx.env)}/api/webhooks/shipping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [advanced.headerName]: advanced.signatureHeader },
        body: advanced.body,
      });
      delivered = res.ok;
    } catch (err) {
      log.warn('mock.shipping_self_delivery_failed', { detail: errMessage(err) });
    }

    if (!delivered) {
      const event = await provider.verifyAndParseWebhook(
        advanced.body,
        new Headers({ [advanced.headerName]: advanced.signatureHeader }),
      );
      await handleShipmentWebhook(ctx, event);
    }

    return ok({
      advanced: true,
      status: advanced.shipment.status,
      awb: advanced.shipment.awbCode,
      webhookDeliveredOverHttp: delivered,
    });
  });
