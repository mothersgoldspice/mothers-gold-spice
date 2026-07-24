/**
 * One order — and the guest tracking page behind the same route.
 *
 * A guest has no session, so their link carries the derived access token as `t`.
 * `assertOrderAccess` accepts either proof, which is why `/account/orders/:id`
 * and `/track/:id?t=…` can read from one endpoint instead of two implementations
 * of the same serialisation drifting apart.
 *
 * Nothing internal to the order row is returned: the guest token hash would hand
 * out the very secret that guards the order, and the idempotency key belongs to
 * the checkout machinery.
 */

import type { APIRoute } from 'astro';
import { rateKey, requireCtx } from '../../../../lib/api';
import type { AppContext } from '../../../../lib/context';
import type { OrderRow } from '../../../../lib/db/types';
import { badRequest, conflict, notFound } from '../../../../lib/errors';
import { handle, ok, readJson } from '../../../../lib/http';
import { errMessage, log } from '../../../../lib/log';
import { RATE_LIMITS, enforceRateLimit } from '../../../../lib/rate-limit';
import { onOrderCancelled } from '../../../../lib/services/order-notifications';
import {
  STATUS_LABEL,
  assertOrderAccess,
  cancelOrder,
  getOrderById,
  isCustomerCancellable,
  loadOrderView,
} from '../../../../lib/services/orders';
import { refundOrder } from '../../../../lib/services/payments';
import { getShipmentForOrder, listShipmentEvents } from '../../../../lib/services/shipments';

export const prerender = false;

/**
 * Resolve the order and prove the caller may see it.
 *
 * Anonymous callers are rate limited because the only thing standing between a
 * walked order id and somebody's home address is the token — a guessing loop
 * must be expensive.
 */
async function loadPermittedOrder(
  locals: App.Locals,
  orderId: string | undefined,
  url: URL,
): Promise<{ ctx: AppContext; order: OrderRow }> {
  const ctx = requireCtx(locals);
  if (!ctx.user) await enforceRateLimit(ctx.db, rateKey(ctx, 'order-track'), RATE_LIMITS.guestTrack);

  if (!orderId) throw badRequest('Missing order reference.');
  const order = await getOrderById(ctx.db, orderId);
  if (!order) throw notFound('We could not find that order.');

  await assertOrderAccess(ctx, order, url.searchParams.get('t'));
  return { ctx, order };
}

export const GET: APIRoute = async ({ locals, params, url }) =>
  handle(async () => {
    const { ctx, order } = await loadPermittedOrder(locals, params.id, url);

    const view = await loadOrderView(ctx.db, order.id);
    const shipment = await getShipmentForOrder(ctx.db, order.id);
    const shipmentEvents = shipment ? await listShipmentEvents(ctx.db, shipment.id) : [];

    return ok({
      order: {
        id: view.order.id,
        orderNumber: view.order.order_number,
        status: view.order.status,
        statusLabel: STATUS_LABEL[view.order.status],
        paymentStatus: view.order.payment_status,
        fulfillmentStatus: view.order.fulfillment_status,
        paymentMethod: view.order.payment_method,
        shippingMethod: view.order.shipping_method,
        customerName: view.order.customer_name,
        subtotalPaise: view.order.subtotal_paise,
        discountPaise: view.order.discount_paise,
        shippingPaise: view.order.shipping_paise,
        codFeePaise: view.order.cod_fee_paise,
        taxPaise: view.order.tax_paise,
        totalPaise: view.order.total_paise,
        refundedPaise: view.order.refunded_paise,
        taxInclusive: view.order.tax_inclusive === 1,
        couponCode: view.order.coupon_code,
        customerNote: view.order.customer_note,
        cancelReason: view.order.cancel_reason,
        placedAt: view.order.placed_at,
        paidAt: view.order.paid_at,
        shippedAt: view.order.shipped_at,
        deliveredAt: view.order.delivered_at,
        cancelledAt: view.order.cancelled_at,
        /** Whether the "Cancel this order" button should be offered at all. */
        cancellable: isCustomerCancellable(view.order.status),
      },
      items: view.items.map((item) => ({
        id: item.id,
        productId: item.product_id,
        variantId: item.variant_id,
        sku: item.sku,
        productName: item.product_name,
        variantName: item.variant_name,
        image: item.image,
        qty: item.qty,
        unitPricePaise: item.unit_price_paise,
        totalPaise: item.total_paise,
      })),
      events: view.events.map((event) => ({
        type: event.type,
        message: event.message,
        createdAt: event.created_at,
      })),
      shippingAddress: view.shippingAddress,
      shipment: shipment
        ? {
            courierName: shipment.courier_name,
            awbCode: shipment.awb_code,
            status: shipment.status,
            trackingUrl: shipment.tracking_url,
            estimatedDeliveryAt: shipment.estimated_delivery_at,
            events: shipmentEvents.map((event) => ({
              status: event.status,
              description: event.description,
              location: event.location,
              occurredAt: event.occurred_at,
            })),
          }
        : null,
    });
  });

/** Customer-initiated cancellation. */
export const POST: APIRoute = async ({ locals, params, request, url }) =>
  handle(async () => {
    const { ctx, order } = await loadPermittedOrder(locals, params.id, url);

    const body = await readJson<{ action?: unknown; reason?: unknown }>(request);
    if (body.action !== 'cancel') throw badRequest('That action is not available on an order.');

    if (!isCustomerCancellable(order.status)) {
      throw conflict(
        `That order is already ${STATUS_LABEL[order.status].toLowerCase()} and cannot be cancelled here. Please write to us and we will sort it out.`,
      );
    }

    const stated = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : '';
    const reason = stated || 'Cancelled by the customer.';
    const actorId = ctx.user?.id ?? null;

    // Cancel first. It is the part the customer asked for, it puts the stock
    // back, and it must not be held hostage by a payment gateway being slow.
    await cancelOrder(ctx.db, order.id, reason, { type: 'customer', id: actorId });

    let refundPaise = 0;
    let refundPending = false;
    // Only prepaid money that actually reached us can be sent back. A COD order
    // was never charged, so there is nothing to return.
    if (order.payment_method === 'prepaid' && order.payment_status === 'paid') {
      try {
        const refund = await refundOrder(ctx, order.id, {
          reason: `Order cancelled: ${reason}`,
          actorId: actorId ?? 'customer',
        });
        refundPaise = refund.amountPaise;
      } catch (err) {
        // The cancellation is already durable and cannot be taken back because
        // the provider refused. Raise it for a human to finish by hand instead
        // of telling the customer their cancellation did not work.
        refundPending = true;
        log.alert('account.cancel_refund_failed', {
          orderId: order.id,
          amountPaise: order.total_paise - order.refunded_paise,
          error: errMessage(err),
        });
      }
    }

    await onOrderCancelled(ctx, order.id, refundPaise);

    const fresh = await getOrderById(ctx.db, order.id);
    log.info('account.order_cancelled', { orderId: order.id, userId: actorId, refundPaise });

    return ok({
      cancelled: true,
      status: fresh?.status ?? 'cancelled',
      statusLabel: STATUS_LABEL[fresh?.status ?? 'cancelled'],
      refundPaise,
      /** True when the money is owed but the provider call has to be retried. */
      refundPending,
    });
  });
