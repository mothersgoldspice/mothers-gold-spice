/**
 * The bridge between order lifecycle and the customer's inbox.
 *
 * Everything that changes an order calls one of these hooks, which is why they
 * live in their own module: the order service stays about state, and there is
 * exactly one place to look when asking "what does a customer receive when X
 * happens?".
 *
 * Every send carries an idempotency key derived from the order and the event, so
 * a retried webhook or a double-clicked admin button cannot mail the same person
 * the same receipt twice.
 */

import type { AppContext } from '../context';
import { parseJson } from '../db/client';
import type { AddressSnapshot, OrderItemRow, OrderRow, ShipmentRow } from '../db/types';
import { siteUrl, supportEmail } from '../env';
import { errMessage, log } from '../log';
import * as templates from '../providers/email/templates';
import { storeContext } from '../providers/email/templates';
import { getOrderById, guestAccessToken } from './orders';
import { notify, queueAndSend } from './notify';

interface OrderBundle {
  order: OrderRow;
  items: OrderItemRow[];
  shippingAddress: AddressSnapshot;
  emailItems: templates.OrderEmailItem[];
  totals: templates.OrderTotals;
}

async function load(ctx: AppContext, orderId: string): Promise<OrderBundle | null> {
  const order = await getOrderById(ctx.db, orderId);
  if (!order) {
    log.warn('order_notifications.order_missing', { orderId });
    return null;
  }
  const items = await ctx.db.all<OrderItemRow>('SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at', [
    orderId,
  ]);

  return {
    order,
    items,
    shippingAddress: parseJson<AddressSnapshot>(order.shipping_address_json, {
      full_name: order.customer_name,
      phone: order.phone,
      line1: '',
      city: '',
      state: '',
      pincode: '',
      country: 'IN',
    }),
    emailItems: items.map((i) => ({
      productName: i.product_name,
      variantName: i.variant_name,
      qty: i.qty,
      unitPricePaise: i.unit_price_paise,
      totalPaise: i.total_paise,
    })),
    totals: {
      subtotalPaise: order.subtotal_paise,
      discountPaise: order.discount_paise,
      shippingPaise: order.shipping_paise,
      codFeePaise: order.cod_fee_paise,
      taxPaise: order.tax_paise,
      totalPaise: order.total_paise,
      taxInclusive: order.tax_inclusive === 1,
      couponCode: order.coupon_code,
    },
  };
}

/**
 * Customer-facing tracking URL.
 *
 * A guest gets a link carrying the derived access token, because order ids are
 * k-sortable and a bare id would be walkable to the previous customer's address.
 * The token is recomputed here rather than threaded through every call site —
 * the shipping email fires days after checkout, in a webhook that never saw the
 * original request.
 */
async function trackUrl(ctx: AppContext, order: OrderRow): Promise<string> {
  const base = siteUrl(ctx.env);
  if (order.is_guest !== 1 && order.user_id) return `${base}/account/orders/${order.id}`;
  const token = await guestAccessToken(ctx.env, order.id);
  return `${base}/track/${order.id}?t=${encodeURIComponent(token)}`;
}

/** Where an operator should be told to look. */
function adminUrl(ctx: AppContext, order: OrderRow): string {
  return `${siteUrl(ctx.env)}/admin/orders/${order.id}`;
}

/**
 * A notification failure must never fail the operation that triggered it. An
 * order that is paid for stays paid even if the confirmation email cannot be
 * composed, so every hook body runs inside this.
 */
async function safely(label: string, orderId: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.error('order_notifications.failed', { hook: label, orderId, error: errMessage(err) });
  }
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

/** Order placed and paid (or COD-confirmed). The receipt. */
export async function onOrderConfirmed(ctx: AppContext, orderId: string): Promise<void> {
  await safely('confirmed', orderId, async () => {
    const bundle = await load(ctx, orderId);
    if (!bundle) return;
    const { order } = bundle;
    const store = storeContext(ctx.env);

    const rendered = templates.orderConfirmation({
      store,
      orderNumber: order.order_number,
      customerName: order.customer_name,
      placedAt: order.placed_at,
      items: bundle.emailItems,
      totals: bundle.totals,
      paymentMethod: order.payment_method,
      shippingAddress: bundle.shippingAddress,
      estimatedDeliveryAt: null,
      trackUrl: await trackUrl(ctx, order),
      customerNote: order.customer_note,
    });

    await queueAndSend(ctx, {
      to: order.email,
      toName: order.customer_name,
      subject: rendered.subject,
      template: rendered.template,
      text: rendered.text,
      html: rendered.html,
      userId: order.user_id,
      orderId: order.id,
      idempotencyKey: `order_confirmation:${order.id}`,
    });

    if (order.user_id) {
      await notify(ctx.db, {
        userId: order.user_id,
        type: 'order.confirmed',
        title: `Order ${order.order_number} confirmed`,
        body: 'We have started packing. You will get a tracking link when it ships.',
        link: `/account/orders/${order.id}`,
        data: { orderId: order.id },
      });
    }

    // Tell the kitchen. Sent to the support address rather than a hardcoded
    // one so changing SUPPORT_EMAIL redirects operations mail with it.
    const adminMail = templates.adminNewOrder({
      store,
      orderNumber: order.order_number,
      placedAt: order.placed_at,
      customerName: order.customer_name,
      customerEmail: order.email,
      customerPhone: order.phone,
      isGuest: order.is_guest === 1,
      paymentMethod: order.payment_method,
      items: bundle.emailItems,
      totals: bundle.totals,
      shippingAddress: bundle.shippingAddress,
      adminUrl: adminUrl(ctx, order),
      customerNote: order.customer_note,
    });

    await queueAndSend(ctx, {
      to: supportEmail(ctx.env),
      toName: 'Orders',
      subject: adminMail.subject,
      template: adminMail.template,
      text: adminMail.text,
      html: adminMail.html,
      orderId: order.id,
      idempotencyKey: `admin_new_order:${order.id}`,
    });
  });
}

export async function onPaymentFailed(ctx: AppContext, orderId: string): Promise<void> {
  await safely('payment_failed', orderId, async () => {
    const bundle = await load(ctx, orderId);
    if (!bundle) return;
    const { order } = bundle;

    const lastFailure = await ctx.db.first<{ failure_reason: string | null }>(
      "SELECT failure_reason FROM payments WHERE order_id = ? AND status = 'failed' ORDER BY updated_at DESC LIMIT 1",
      [orderId],
    );

    const rendered = templates.paymentFailed({
      store: storeContext(ctx.env),
      orderNumber: order.order_number,
      customerName: order.customer_name,
      totalPaise: order.total_paise,
      retryUrl: `${siteUrl(ctx.env)}/checkout/retry/${order.id}`,
      reason: lastFailure?.failure_reason ?? null,
      reservedUntil: order.reserved_until,
    });

    await queueAndSend(ctx, {
      to: order.email,
      toName: order.customer_name,
      subject: rendered.subject,
      template: rendered.template,
      text: rendered.text,
      html: rendered.html,
      userId: order.user_id,
      orderId: order.id,
      // Keyed on the attempt count so a second genuine failure does mail again.
      idempotencyKey: `payment_failed:${order.id}:${order.updated_at}`,
    });

    if (order.user_id) {
      await notify(ctx.db, {
        userId: order.user_id,
        type: 'order.payment_failed',
        title: `Payment failed for ${order.order_number}`,
        body: 'Your items are held for a short while. Tap to try paying again.',
        link: `/checkout/retry/${order.id}`,
        data: { orderId: order.id },
      });
    }
  });
}

export async function onOrderCancelled(ctx: AppContext, orderId: string, refundPaise = 0): Promise<void> {
  await safely('cancelled', orderId, async () => {
    const bundle = await load(ctx, orderId);
    if (!bundle) return;
    const { order } = bundle;

    const rendered = templates.orderCancelled({
      store: storeContext(ctx.env),
      orderNumber: order.order_number,
      customerName: order.customer_name,
      cancelledAt: order.cancelled_at ?? Date.now(),
      reason: order.cancel_reason ?? 'Order cancelled.',
      paymentMethod: order.payment_method,
      refundPaise,
      shopUrl: `${siteUrl(ctx.env)}/shop`,
    });

    await queueAndSend(ctx, {
      to: order.email,
      toName: order.customer_name,
      subject: rendered.subject,
      template: rendered.template,
      text: rendered.text,
      html: rendered.html,
      userId: order.user_id,
      orderId: order.id,
      idempotencyKey: `order_cancelled:${order.id}`,
    });

    if (order.user_id) {
      await notify(ctx.db, {
        userId: order.user_id,
        type: 'order.cancelled',
        title: `Order ${order.order_number} cancelled`,
        body: order.cancel_reason ?? '',
        link: `/account/orders/${order.id}`,
        data: { orderId: order.id },
      });
    }
  });
}

export async function onOrderShipped(ctx: AppContext, orderId: string, shipment: ShipmentRow): Promise<void> {
  await safely('shipped', orderId, async () => {
    const bundle = await load(ctx, orderId);
    if (!bundle) return;
    const { order } = bundle;

    const rendered = templates.orderShipped({
      store: storeContext(ctx.env),
      orderNumber: order.order_number,
      customerName: order.customer_name,
      courierName: shipment.courier_name ?? 'our delivery partner',
      awbCode: shipment.awb_code ?? '',
      trackingUrl: shipment.tracking_url?.startsWith('http')
        ? shipment.tracking_url
        : await trackUrl(ctx, order),
      shippedAt: shipment.shipped_at ?? Date.now(),
      estimatedDeliveryAt: shipment.estimated_delivery_at,
      items: bundle.emailItems,
      shippingAddress: bundle.shippingAddress,
    });

    await queueAndSend(ctx, {
      to: order.email,
      toName: order.customer_name,
      subject: rendered.subject,
      template: rendered.template,
      text: rendered.text,
      html: rendered.html,
      userId: order.user_id,
      orderId: order.id,
      idempotencyKey: `order_shipped:${order.id}:${shipment.id}`,
    });

    if (order.user_id) {
      await notify(ctx.db, {
        userId: order.user_id,
        type: 'order.shipped',
        title: `Order ${order.order_number} shipped`,
        body: shipment.awb_code ? `${shipment.courier_name ?? 'Courier'} · AWB ${shipment.awb_code}` : '',
        link: `/account/orders/${order.id}`,
        data: { orderId: order.id, awb: shipment.awb_code },
      });
    }
  });
}

export async function onOutForDelivery(ctx: AppContext, orderId: string, shipment: ShipmentRow): Promise<void> {
  await safely('out_for_delivery', orderId, async () => {
    const bundle = await load(ctx, orderId);
    if (!bundle) return;
    const { order } = bundle;

    const rendered = templates.orderOutForDelivery({
      store: storeContext(ctx.env),
      orderNumber: order.order_number,
      customerName: order.customer_name,
      courierName: shipment.courier_name ?? 'our delivery partner',
      awbCode: shipment.awb_code ?? '',
      trackingUrl: shipment.tracking_url?.startsWith('http') ? shipment.tracking_url : await trackUrl(ctx, order),
      paymentMethod: order.payment_method,
      codAmountPaise: order.payment_method === 'cod' ? order.total_paise : 0,
    });

    await queueAndSend(ctx, {
      to: order.email,
      toName: order.customer_name,
      subject: rendered.subject,
      template: rendered.template,
      text: rendered.text,
      html: rendered.html,
      userId: order.user_id,
      orderId: order.id,
      idempotencyKey: `order_ofd:${order.id}:${shipment.id}`,
    });
  });
}

export async function onOrderDelivered(ctx: AppContext, orderId: string): Promise<void> {
  await safely('delivered', orderId, async () => {
    const bundle = await load(ctx, orderId);
    if (!bundle) return;
    const { order } = bundle;
    const firstItem = bundle.items[0];

    // order_items snapshots product_id, but /shop/[slug] resolves by slug and
    // only serves active products. Linking by id sent every "how was it?" email
    // to a 404. The slug is looked up now, and anything that no longer resolves
    // falls back to the shop index rather than a dead page.
    const reviewProduct = firstItem
      ? await ctx.db.first<{ slug: string }>("SELECT slug FROM products WHERE id = ? AND status = 'active'", [
          firstItem.product_id,
        ])
      : null;

    const rendered = templates.orderDelivered({
      store: storeContext(ctx.env),
      orderNumber: order.order_number,
      customerName: order.customer_name,
      deliveredAt: order.delivered_at ?? Date.now(),
      reviewUrl: reviewProduct
        ? `${siteUrl(ctx.env)}/shop/${reviewProduct.slug}?review=${encodeURIComponent(order.id)}`
        : `${siteUrl(ctx.env)}/shop`,
    });

    await queueAndSend(ctx, {
      to: order.email,
      toName: order.customer_name,
      subject: rendered.subject,
      template: rendered.template,
      text: rendered.text,
      html: rendered.html,
      userId: order.user_id,
      orderId: order.id,
      idempotencyKey: `order_delivered:${order.id}`,
      // A review request lands better the day after the jar arrives than at the
      // moment the courier hands it over.
      scheduledAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    if (order.user_id) {
      await notify(ctx.db, {
        userId: order.user_id,
        type: 'order.delivered',
        title: `Order ${order.order_number} delivered`,
        body: 'We hope it tastes like home. Tell us what you think.',
        link: `/account/orders/${order.id}`,
        data: { orderId: order.id },
      });
    }
  });
}

export async function onRefundIssued(ctx: AppContext, orderId: string, amountPaise: number): Promise<void> {
  await safely('refund', orderId, async () => {
    const bundle = await load(ctx, orderId);
    if (!bundle) return;
    const { order } = bundle;

    const payment = await ctx.db.first<{ method: string | null }>(
      "SELECT method FROM payments WHERE order_id = ? AND status IN ('paid','refunded','partially_refunded') ORDER BY created_at DESC LIMIT 1",
      [orderId],
    );

    const rendered = templates.refundIssued({
      store: storeContext(ctx.env),
      orderNumber: order.order_number,
      customerName: order.customer_name,
      amountPaise,
      // Deliberately generic: a template must never name a payment vendor.
      refundMethod: payment?.method
        ? `the ${payment.method.toUpperCase()} account you paid from`
        : 'your original payment method',
      issuedAt: Date.now(),
      reason: order.cancel_reason,
      orderUrl: await trackUrl(ctx, order),
      isPartial: amountPaise < order.total_paise,
    });

    await queueAndSend(ctx, {
      to: order.email,
      toName: order.customer_name,
      subject: rendered.subject,
      template: rendered.template,
      text: rendered.text,
      html: rendered.html,
      userId: order.user_id,
      orderId: order.id,
      idempotencyKey: `refund:${order.id}:${amountPaise}:${Math.floor(Date.now() / 60000)}`,
    });

    if (order.user_id) {
      await notify(ctx.db, {
        userId: order.user_id,
        type: 'order.refunded',
        title: `Refund issued for ${order.order_number}`,
        body: 'It usually reaches your account in 5-7 working days.',
        link: `/account/orders/${order.id}`,
        data: { orderId: order.id, amountPaise },
      });
    }
  });
}
