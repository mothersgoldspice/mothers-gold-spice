/**
 * Staff actions on a booked parcel.
 *
 * All three are courier round trips, which is why they are POST rather than
 * something a page could trigger by being loaded. Refreshing tracking is the one
 * an operator reaches for most: couriers drop callbacks, and asking for the whole
 * scan history is always safe because `ingestTrackingEvent` dedupes on the
 * provider's event id and the order state machine refuses to walk backwards.
 */

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdmin } from '../../../../lib/api';
import type { ShipmentEventRow, ShipmentRow } from '../../../../lib/db/types';
import { badRequest, conflict, notFound, providerError } from '../../../../lib/errors';
import { handle, ok, readJson } from '../../../../lib/http';
import { newId } from '../../../../lib/ids';
import { errMessage, log } from '../../../../lib/log';
import { cancelShipment, listShipmentEvents, refreshTracking } from '../../../../lib/services/shipments';
import { parseOrThrow } from '../../../../lib/validate';

export const prerender = false;

const actionSchema = z.object({
  action: z.enum(['refresh', 'cancel', 'label'], {
    errorMap: () => ({ message: 'That is not an action we support on a parcel.' }),
  }),
});

export const POST: APIRoute = async ({ locals, params, request }) =>
  handle(async () => {
    const { ctx, user } = requireAdmin(locals);

    const shipmentId = params.id?.trim();
    if (!shipmentId) throw badRequest('Missing shipment reference.');

    const { action } = parseOrThrow(actionSchema, await readJson<Record<string, unknown>>(request));

    const shipment = await ctx.db.first<ShipmentRow>('SELECT * FROM shipments WHERE id = ?', [shipmentId]);
    if (!shipment) throw notFound('We could not find that shipment.');

    let result: ShipmentRow = shipment;
    let extra: Record<string, unknown> = {};

    switch (action) {
      case 'refresh': {
        result = await refreshTracking(ctx, shipmentId);
        break;
      }

      case 'cancel': {
        await cancelShipment(ctx, shipmentId, user.id);
        result = (await ctx.db.first<ShipmentRow>('SELECT * FROM shipments WHERE id = ?', [shipmentId])) ?? shipment;
        break;
      }

      case 'label': {
        if (!shipment.provider_shipment_id) {
          throw conflict('The courier has not given this parcel an id yet, so there is no label to print.');
        }

        let label: Awaited<ReturnType<typeof ctx.shipping.generateLabel>>;
        try {
          label = await ctx.shipping.generateLabel(shipment.provider_shipment_id);
        } catch (err) {
          log.warn('admin.label_failed', { shipmentId, error: errMessage(err) });
          throw providerError('The courier could not produce a label just now. Please try again in a moment.', err);
        }

        // Cache the URL on the shipment: labels are fetched again at packing
        // time, and a second round trip to reprint the same sticker is waste.
        if (label.labelUrl) {
          await ctx.db.run('UPDATE shipments SET label_url = ?, updated_at = ? WHERE id = ?', [
            label.labelUrl,
            Date.now(),
            shipmentId,
          ]);
          result = { ...shipment, label_url: label.labelUrl };
        }
        extra = { labelUrl: label.labelUrl ?? shipment.label_url };
        break;
      }
    }

    await ctx.db.run(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, data_json, ip, created_at)
       VALUES (?, 'admin', ?, ?, 'shipment', ?, ?, ?, ?)`,
      [
        newId('aud'),
        user.id,
        `shipment.${action}`,
        shipmentId,
        JSON.stringify({ orderId: shipment.order_id, status: result.status, ...extra }),
        ctx.clientIp,
        Date.now(),
      ],
    );

    log.info('admin.shipment_action', { shipmentId, action, actorId: user.id });

    const events: ShipmentEventRow[] = await listShipmentEvents(ctx.db, shipmentId);
    return ok({ action, shipment: result, events, ...extra });
  });
