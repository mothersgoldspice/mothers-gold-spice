/**
 * One order, from the staff side.
 *
 * GET returns everything an operator needs on one screen — the order, its items,
 * the full (including internal) timeline, every payment and refund, and the
 * parcel with its scans — because chasing "where is this order" across four
 * requests on a phone in a kitchen is how mistakes happen.
 *
 * PATCH is a small command dispatcher rather than a field-level update. An order
 * is not a document you edit; it is a state machine plus money, so the API
 * exposes the operations that are safe (advance the status, book a parcel, issue
 * a refund) and nothing else. Every one of them is written to `audit_log` with
 * the operator's id and IP: when a customer asks who cancelled their order, the
 * answer has to exist.
 */

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdmin } from '../../../../lib/api';
import type { AppContext } from '../../../../lib/context';
import type { OrderRow, PaymentRow, RefundRow, ShipmentEventRow } from '../../../../lib/db/types';
import { badRequest, conflict } from '../../../../lib/errors';
import { handle, ok, readJson } from '../../../../lib/http';
import { newId } from '../../../../lib/ids';
import { log } from '../../../../lib/log';
import { dispatchOne } from '../../../../lib/services/notify';
import {
  onOrderCancelled,
  onOrderConfirmed,
  onOrderDelivered,
} from '../../../../lib/services/order-notifications';
import {
  cancelOrder,
  confirmOrder,
  loadOrderView,
  orderEventStatement,
  transitionOrder,
  type OrderView,
} from '../../../../lib/services/orders';
import { refundOrder } from '../../../../lib/services/payments';
import { createShipmentForOrder, getShipmentForOrder } from '../../../../lib/services/shipments';
import { orderStatusSchema, parseOrThrow, refundSchema } from '../../../../lib/validate';

export const prerender = false;

interface AdminOrderView extends OrderView {
  payments: PaymentRow[];
  refunds: RefundRow[];
  shipment: Awaited<ReturnType<typeof getShipmentForOrder>>;
  shipmentEvents: ShipmentEventRow[];
}

/** Everything about one order, assembled once and reused by GET and PATCH. */
async function loadAdminOrder(ctx: AppContext, orderId: string): Promise<AdminOrderView> {
  const view = await loadOrderView(ctx.db, orderId, { adminView: true });

  const [payments, refunds, shipment, shipmentEvents] = await Promise.all([
    ctx.db.all<PaymentRow>('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC', [orderId]),
    ctx.db.all<RefundRow>('SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at DESC', [orderId]),
    getShipmentForOrder(ctx.db, orderId),
    // Scoped by order rather than by shipment so a re-booked parcel still shows
    // the scans from the booking it replaced.
    ctx.db.all<ShipmentEventRow>('SELECT * FROM shipment_events WHERE order_id = ? ORDER BY occurred_at DESC', [
      orderId,
    ]),
  ]);

  return { ...view, payments, refunds, shipment, shipmentEvents };
}

/**
 * Who did what, to which order, from where. Written after the operation
 * succeeds — an audit row for a refund that the provider rejected would be a lie.
 */
async function recordAudit(
  ctx: AppContext,
  actorId: string,
  action: string,
  orderId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await ctx.db.run(
    `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, data_json, ip, created_at)
     VALUES (?, 'admin', ?, ?, 'order', ?, ?, ?, ?)`,
    [newId('aud'), actorId, action, orderId, JSON.stringify(data), ctx.clientIp, Date.now()],
  );
}

function orderId(params: Record<string, string | undefined>): string {
  const id = params.id?.trim();
  if (!id) throw badRequest('Missing order reference.');
  return id;
}

export const GET: APIRoute = async ({ locals, params }) =>
  handle(async () => {
    const { ctx } = requireAdmin(locals);
    return ok(await loadAdminOrder(ctx, orderId(params)));
  });

const actionSchema = z.object({
  action: z.enum(['status', 'note', 'ship', 'refund', 'resend_confirmation'], {
    errorMap: () => ({ message: 'That is not an action we support on an order.' }),
  }),
});

const noteSchema = z.object({
  /** Empty clears the note. */
  note: z.string().trim().max(2000, 'Keep the internal note under 2000 characters.'),
});

const shipSchema = z.object({
  courier_id: z.string().trim().min(1).max(80).optional().nullable(),
});

export const PATCH: APIRoute = async ({ locals, params, request }) =>
  handle(async () => {
    const { ctx, user } = requireAdmin(locals);
    const id = orderId(params);
    const body = await readJson<Record<string, unknown>>(request);
    const { action } = parseOrThrow(actionSchema, body);
    let result: Record<string, unknown> = {};

    switch (action) {
      case 'status': {
        const { status, note } = parseOrThrow(orderStatusSchema, body);

        if (status === 'cancelled') {
          // Cancelling is not a plain transition: whichever stock state the
          // order is in — held, or already sold — has to be handed back, and
          // only `cancelOrder` knows which.
          const reason = note?.trim() || 'Cancelled by our team.';
          const cancelled = await cancelOrder(ctx.db, id, reason, { type: 'admin', id: user.id });
          // The customer is told what was already refunded, not what might be:
          // an admin refund sends its own email when it is actually issued.
          await onOrderCancelled(ctx, id, cancelled.refunded_paise);
        } else if (status === 'confirmed') {
          // Confirming is where reserved stock becomes sold stock. Routing this
          // through `transitionOrder` would flip the status and leave the units
          // reserved forever, so availability would shrink with every manually
          // confirmed order. `confirmOrder` is idempotent, so a webhook that
          // lands a second later is a no-op.
          const order = await ctx.db.first<OrderRow>('SELECT * FROM orders WHERE id = ?', [id]);
          if (!order) throw conflict('We could not find that order.');
          const { alreadyConfirmed } = await confirmOrder(ctx.db, id, {
            // A COD order is confirmed with the money still outstanding.
            paymentStatus: order.payment_method === 'cod' ? 'pending' : 'paid',
            message: note?.trim() || undefined,
            actorId: user.id,
          });
          if (!alreadyConfirmed) await onOrderConfirmed(ctx, id);
        } else {
          await transitionOrder(ctx.db, {
            orderId: id,
            to: status,
            message: note?.trim() || undefined,
            actorType: 'admin',
            actorId: user.id,
          });
          if (status === 'delivered') await onOrderDelivered(ctx, id);
        }

        await recordAudit(ctx, user.id, `order.status.${status}`, id, { status, note: note ?? null });
        result = { status };
        break;
      }

      case 'note': {
        const { note } = parseOrThrow(noteSchema, body);
        const value = note.length > 0 ? note : null;
        await ctx.db.batch([
          ctx.db.stmt('UPDATE orders SET admin_note = ?, updated_at = ? WHERE id = ?', [value, Date.now(), id]),
          orderEventStatement(ctx.db, {
            orderId: id,
            type: 'order.note',
            message: value ? `Internal note updated: ${value}` : 'Internal note cleared.',
            actorType: 'admin',
            actorId: user.id,
            // An internal note is exactly that — it must never surface on the
            // customer's tracking page.
            customerVisible: false,
          }),
        ]);
        await recordAudit(ctx, user.id, 'order.note', id, { note: value });
        result = { note: value };
        break;
      }

      case 'ship': {
        const { courier_id: courierId } = parseOrThrow(shipSchema, body);
        const shipment = await createShipmentForOrder(ctx, id, { courierId: courierId ?? null, actorId: user.id });
        await recordAudit(ctx, user.id, 'order.ship', id, {
          shipmentId: shipment.id,
          awb: shipment.awb_code,
          courier: shipment.courier_name,
        });
        result = { shipmentId: shipment.id, awb: shipment.awb_code, courier: shipment.courier_name };
        break;
      }

      case 'refund': {
        const { amount_paise: amountPaise, reason } = parseOrThrow(refundSchema, body);
        const refund = await refundOrder(ctx, id, { amountPaise, reason, actorId: user.id });
        await recordAudit(ctx, user.id, 'order.refund', id, {
          refundId: refund.refundId,
          amountPaise: refund.amountPaise,
          status: refund.status,
          reason,
        });
        result = { refundId: refund.refundId, amountPaise: refund.amountPaise, status: refund.status };
        break;
      }

      case 'resend_confirmation': {
        // The receipt is queued under a fixed idempotency key so a retried
        // webhook cannot mail it twice — which also means composing it again is
        // silently discarded. A genuine resend therefore re-dispatches the row
        // that already exists, and only composes a fresh one when the order has
        // somehow never had a confirmation queued at all.
        const existing = await ctx.db.first<{ id: string }>(
          'SELECT id FROM email_outbox WHERE order_id = ? AND idempotency_key = ? LIMIT 1',
          [id, `order_confirmation:${id}`],
        );

        if (existing) {
          const now = Date.now();
          await ctx.db.run(
            `UPDATE email_outbox SET status = 'queued', attempts = 0, last_error = NULL,
                    scheduled_at = ?, updated_at = ? WHERE id = ?`,
            [now, now, existing.id],
          );
          result = { emailId: existing.id, sent: await dispatchOne(ctx.db, ctx.email, existing.id) };
        } else {
          await onOrderConfirmed(ctx, id);
          result = { emailId: null, sent: true };
        }

        await recordAudit(ctx, user.id, 'order.resend_confirmation', id, result);
        break;
      }
    }

    log.info('admin.order_action', { orderId: id, action, actorId: user.id });
    return ok({ action, result, ...(await loadAdminOrder(ctx, id)) });
  });
