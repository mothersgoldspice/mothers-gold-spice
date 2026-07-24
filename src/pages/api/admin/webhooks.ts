/**
 * Provider callbacks, and the ability to run one again.
 *
 * Every webhook is recorded before it is acted on, so a payment we heard about
 * but failed to apply is a row rather than a mystery. This endpoint is how that
 * row gets turned back into a confirmed order.
 *
 * A replay does NOT re-check a signature: the trust boundary is our own stored
 * payload, which was verified when it arrived. That is precisely why the payment
 * provider exposes `parseTrustedWebhook` as a separate method rather than a
 * `skipVerify` flag — a flag is something a request handler could be talked into
 * passing, a second method is something you have to mean.
 *
 * The list omits `payload_json`; a page of 25 raw provider payloads is most of a
 * megabyte on a phone. Ask for one row by id to read the body.
 */

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { readPaging, requireAdmin } from '../../../lib/api';
import type { AppContext } from '../../../lib/context';
import type { WebhookEventRow } from '../../../lib/db/types';
import { conflict, notFound } from '../../../lib/errors';
import { handle, ok, readJson } from '../../../lib/http';
import { newId } from '../../../lib/ids';
import { errMessage, log } from '../../../lib/log';
import { replayPaymentEvent } from '../../../lib/services/payments';
import { getShipmentForOrder, refreshTracking } from '../../../lib/services/shipments';
import { parseOrThrow } from '../../../lib/validate';

export const prerender = false;

type WebhookSummary = Omit<WebhookEventRow, 'payload_json'>;

const SUMMARY_COLUMNS =
  'id, source, provider, event_id, event_type, status, signature_valid, error, attempts, order_id, received_at, processed_at';

const filterSchema = z.object({
  source: z.enum(['payment', 'shipping']).nullable().optional(),
  status: z.enum(['received', 'processed', 'failed', 'ignored']).nullable().optional(),
});

export const GET: APIRoute = async ({ locals, url }) =>
  handle(async () => {
    const { ctx } = requireAdmin(locals);

    const single = url.searchParams.get('id');
    if (single) {
      const row = await ctx.db.first<WebhookEventRow>('SELECT * FROM webhook_events WHERE id = ?', [single]);
      if (!row) throw notFound('We could not find that webhook event.');
      return ok({ event: row });
    }

    const { limit, offset } = readPaging(url, 25, 100);
    const filters = parseOrThrow(filterSchema, {
      source: url.searchParams.get('source') || null,
      status: url.searchParams.get('status') || null,
    });

    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filters.source) {
      where.push('source = ?');
      params.push(filters.source);
    }
    if (filters.status) {
      where.push('status = ?');
      params.push(filters.status);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const total = (await ctx.db.scalar<number>(`SELECT COUNT(*) FROM webhook_events ${clause}`, params)) ?? 0;
    const items = await ctx.db.all<WebhookSummary>(
      `SELECT ${SUMMARY_COLUMNS} FROM webhook_events ${clause} ORDER BY received_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return ok({ items, total, limit, offset, hasMore: offset + items.length < total });
  });

const replaySchema = z.object({
  id: z.string().trim().min(1, 'Which event?'),
  action: z.literal('replay', { errorMap: () => ({ message: 'The only action here is replay.' }) }),
});

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireAdmin(locals);
    const { id } = parseOrThrow(replaySchema, await readJson<Record<string, unknown>>(request));

    const row = await ctx.db.first<WebhookEventRow>('SELECT * FROM webhook_events WHERE id = ?', [id]);
    if (!row) throw notFound('We could not find that webhook event.');

    const result =
      row.source === 'payment' ? await replayPayment(ctx, row) : await replayShipping(ctx, row);

    await ctx.db.run(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, data_json, ip, created_at)
       VALUES (?, 'admin', ?, 'webhook.replay', 'webhook_event', ?, ?, ?, ?)`,
      [
        newId('aud'),
        user.id,
        row.id,
        JSON.stringify({ source: row.source, provider: row.provider, eventId: row.event_id, ...result }),
        ctx.clientIp,
        Date.now(),
      ],
    );

    log.info('admin.webhook_replayed', { eventId: row.event_id, source: row.source, actorId: user.id, ...result });

    const fresh = await ctx.db.first<WebhookSummary>(
      `SELECT ${SUMMARY_COLUMNS} FROM webhook_events WHERE provider = ? AND event_id = ?`,
      [row.provider, row.event_id],
    );
    return ok({ ...result, event: fresh });
  });

/**
 * Re-apply a stored payment callback.
 *
 * Goes through `replayPaymentEvent`, which applies the event WITHOUT the
 * idempotency insert. `handlePaymentWebhook` cannot be used here: its
 * UNIQUE (provider, event_id) insert is its own once-only guard, so a replay
 * would collide with the very row being replayed and report "duplicate" having
 * done nothing. Deleting the audit row to make way for a fresh one was the other
 * option, and it loses the only record of a payment callback if anything fails
 * in between — so the row stays exactly where it is.
 */
async function replayPayment(ctx: AppContext, row: WebhookEventRow): Promise<Record<string, unknown>> {
  const event = await ctx.payment.parseTrustedWebhook(row.payload_json);

  try {
    const outcome = await replayPaymentEvent(ctx, event);
    await ctx.db.run(
      `UPDATE webhook_events SET status = ?, error = NULL, attempts = attempts + 1, processed_at = ? WHERE id = ?`,
      [outcome === 'ignored' ? 'ignored' : 'processed', Date.now(), row.id],
    );
    return { outcome, orderId: event.orderId };
  } catch (err) {
    await ctx.db.run(
      `UPDATE webhook_events SET status = 'failed', error = ?, attempts = attempts + 1, processed_at = ? WHERE id = ?`,
      [errMessage(err).slice(0, 1000), Date.now(), row.id],
    );
    throw err;
  }
}

/**
 * Re-apply a stored courier callback.
 *
 * There is no shipping equivalent of `parseTrustedWebhook`, and adding one would
 * be the wrong shape anyway: a stored scan is a courier's claim from hours ago,
 * whereas the shipment it refers to can simply be asked again. Re-pulling the
 * whole tracking history is both more current and free of any vendor field names
 * leaking out of the provider folder. Duplicate scans are absorbed by the UNIQUE
 * (shipment_id, provider_event_id) on `shipment_events`.
 */
async function replayShipping(ctx: AppContext, row: WebhookEventRow): Promise<Record<string, unknown>> {
  if (!row.order_id) {
    throw conflict(
      'That courier callback was never matched to an order, so there is nothing to replay. Find the parcel and refresh its tracking instead.',
    );
  }

  const shipment = await getShipmentForOrder(ctx.db, row.order_id);
  if (!shipment) throw conflict('That order has no live parcel to refresh.');

  const refreshed = await refreshTracking(ctx, shipment.id);

  await ctx.db.run(
    `UPDATE webhook_events SET status = 'processed', attempts = attempts + 1, error = NULL, processed_at = ?
      WHERE id = ?`,
    [Date.now(), row.id],
  );

  return { outcome: 'processed', orderId: row.order_id, shipmentId: refreshed.id, shipmentStatus: refreshed.status };
}
