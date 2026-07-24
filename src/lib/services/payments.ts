/**
 * Payments: starting a checkout, reconciling provider callbacks, and refunds.
 *
 * The provider is reached only through `ctx.payment` (a `PaymentProvider`), so
 * nothing below knows whether the money is moving through Paddle, Razorpay or
 * the mock gateway.
 *
 * Two invariants hold the money path together:
 *
 *  1. A webhook is recorded before it is acted on, keyed `(provider, event_id)`.
 *     A duplicate delivery is detected as a duplicate insert and ignored, so a
 *     provider's retry storm cannot confirm an order twice or double-decrement
 *     stock.
 *  2. The AMOUNT is verified against the order before anything is marked paid.
 *     A callback claiming ₹1 for a ₹998 order is refused and flagged.
 */

import type { AppContext } from '../context';
import type { Db } from '../db/client';
import type { OrderRow, PaymentRow } from '../db/types';
import { badRequest, conflict, notFound, providerError } from '../errors';
import { siteUrl } from '../env';
import { newId } from '../ids';
import { errMessage, log } from '../log';
import { formatPaise } from '../money';
import type { PaymentWebhookEvent } from '../providers/payment/types';
import { confirmOrder, getOrderById, orderEventStatement, orderStockLines, transitionOrder } from './orders';
import { releaseReservation } from './inventory';

export interface StartPaymentResult {
  paymentId: string;
  checkoutUrl: string;
  providerCheckoutId: string;
  provider: string;
}

/**
 * Create (or reuse) a checkout session for an order.
 *
 * A pending payment row for the same order is reused rather than superseded, so
 * a customer who reloads the redirect page does not spawn a second transaction
 * at the provider for the same money.
 */
export async function startPayment(ctx: AppContext, order: OrderRow): Promise<StartPaymentResult> {
  if (order.payment_status === 'paid') throw conflict('That order is already paid.');
  if (order.status === 'cancelled') throw conflict('That order was cancelled.');
  if (order.payment_method === 'cod') throw badRequest('Cash-on-delivery orders do not need an online payment.');

  const provider = ctx.payment;

  const existing = await ctx.db.first<PaymentRow>(
    `SELECT * FROM payments WHERE order_id = ? AND provider = ? AND status = 'pending' AND checkout_url IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [order.id, provider.name],
  );
  if (existing && existing.amount_paise === order.total_paise && existing.checkout_url) {
    log.info('payments.reusing_checkout', { orderId: order.id, paymentId: existing.id });
    return {
      paymentId: existing.id,
      checkoutUrl: existing.checkout_url,
      providerCheckoutId: existing.provider_checkout_id ?? '',
      provider: provider.name,
    };
  }

  const items = await ctx.db.all<{
    product_name: string;
    variant_name: string;
    sku: string;
    qty: number;
    unit_price_paise: number;
  }>('SELECT product_name, variant_name, sku, qty, unit_price_paise FROM order_items WHERE order_id = ?', [order.id]);

  const base = siteUrl(ctx.env);
  const paymentId = newId('pay');
  const now = Date.now();

  let result;
  try {
    result = await provider.createCheckout({
      orderId: order.id,
      orderNumber: order.order_number,
      // Charge exactly what the order says. Recomputing here would risk the
      // customer being charged a number the order row does not agree with.
      amountPaise: order.total_paise,
      currency: order.currency,
      customer: { email: order.email, name: order.customer_name, phone: order.phone },
      items: items.map((i) => ({
        name: `${i.product_name} ${i.variant_name}`,
        description: `${i.product_name} — ${i.variant_name}`,
        sku: i.sku,
        quantity: i.qty,
        unitAmountPaise: i.unit_price_paise,
      })),
      shippingPaise: order.shipping_paise + order.cod_fee_paise,
      discountPaise: order.discount_paise,
      successUrl: `${base}/checkout/return?order=${encodeURIComponent(order.id)}`,
      cancelUrl: `${base}/checkout/return?order=${encodeURIComponent(order.id)}&cancelled=1`,
      metadata: { order_number: order.order_number },
    });
  } catch (err) {
    log.error('payments.checkout_failed', { orderId: order.id, provider: provider.name, error: errMessage(err) });
    throw providerError('We could not reach the payment provider. Please try again in a moment.', err);
  }

  await ctx.db.batch([
    ctx.db.stmt(
      `INSERT INTO payments (id, order_id, provider, provider_checkout_id, provider_customer_id, status,
                             amount_paise, currency, checkout_url, raw_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      [
        paymentId,
        order.id,
        provider.name,
        result.providerCheckoutId,
        result.providerCustomerId,
        order.total_paise,
        order.currency,
        result.checkoutUrl,
        JSON.stringify(result.raw ?? {}).slice(0, 4000),
        now,
        now,
      ],
    ),
    orderEventStatement(ctx.db, {
      orderId: order.id,
      type: 'payment.started',
      message: `Payment of ${formatPaise(order.total_paise)} started.`,
      data: { provider: provider.name, providerCheckoutId: result.providerCheckoutId },
      customerVisible: false,
    }),
  ]);

  log.info('payments.checkout_created', {
    orderId: order.id,
    paymentId,
    provider: provider.name,
    amountPaise: order.total_paise,
  });

  return {
    paymentId,
    checkoutUrl: result.checkoutUrl,
    providerCheckoutId: result.providerCheckoutId,
    provider: provider.name,
  };
}

/**
 * Confirm a cash-on-delivery order. There is no gateway, so the order moves
 * straight to confirmed with the payment still outstanding.
 */
export async function confirmCodOrder(ctx: AppContext, order: OrderRow): Promise<OrderRow> {
  if (order.payment_method !== 'cod') throw badRequest('That order is not cash on delivery.');

  await ctx.db.run(
    `INSERT INTO payments (id, order_id, provider, status, amount_paise, currency, method, raw_json, created_at, updated_at)
     VALUES (?, ?, 'cod', 'pending', ?, ?, 'cod', '{}', ?, ?)`,
    [newId('pay'), order.id, order.total_paise, order.currency, Date.now(), Date.now()],
  );

  const { order: confirmed } = await confirmOrder(ctx.db, order.id, {
    paymentStatus: 'pending',
    message: `Order confirmed. Please keep ${formatPaise(order.total_paise)} ready for the delivery partner.`,
  });
  return confirmed;
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored' | 'failed';

/**
 * Record a verified webhook and act on it exactly once.
 *
 * The UNIQUE (provider, event_id) insert IS the lock: whichever concurrent
 * delivery wins the insert processes the event, and the losers see the
 * constraint violation and return `duplicate`.
 */
export async function handlePaymentWebhook(
  ctx: AppContext,
  event: PaymentWebhookEvent,
  signatureValid: boolean,
): Promise<{ outcome: WebhookOutcome; orderId: string | null }> {
  const provider = ctx.payment.name;
  const now = Date.now();
  const webhookId = newId('whk');

  try {
    await ctx.db.run(
      `INSERT INTO webhook_events (id, source, provider, event_id, event_type, status, signature_valid,
                                   payload_json, attempts, order_id, received_at)
       VALUES (?, 'payment', ?, ?, ?, 'received', ?, ?, 1, ?, ?)`,
      [
        webhookId,
        provider,
        event.eventId,
        event.providerEventName,
        signatureValid ? 1 : 0,
        JSON.stringify(event.raw).slice(0, 20000),
        event.orderId,
        now,
      ],
    );
  } catch (err) {
    const message = errMessage(err);
    if (message.includes('UNIQUE') || message.includes('constraint')) {
      log.info('webhook.duplicate', { provider, eventId: event.eventId, type: event.providerEventName });
      return { outcome: 'duplicate', orderId: event.orderId };
    }
    throw err;
  }

  try {
    const outcome = await applyPaymentEvent(ctx, event);
    await ctx.db.run('UPDATE webhook_events SET status = ?, processed_at = ? WHERE id = ?', [
      outcome === 'ignored' ? 'ignored' : 'processed',
      Date.now(),
      webhookId,
    ]);
    return { outcome, orderId: event.orderId };
  } catch (err) {
    await ctx.db.run('UPDATE webhook_events SET status = ?, error = ?, processed_at = ? WHERE id = ?', [
      'failed',
      errMessage(err).slice(0, 1000),
      Date.now(),
      webhookId,
    ]);
    log.error('webhook.processing_failed', {
      provider,
      eventId: event.eventId,
      type: event.providerEventName,
      error: errMessage(err),
    });
    throw err;
  }
}

async function applyPaymentEvent(ctx: AppContext, event: PaymentWebhookEvent): Promise<WebhookOutcome> {
  if (event.type === 'unknown') {
    log.info('webhook.ignored_event_type', { type: event.providerEventName });
    return 'ignored';
  }

  const order = await resolveOrder(ctx.db, event);
  if (!order) {
    log.warn('webhook.unattributable', { eventId: event.eventId, type: event.providerEventName });
    return 'ignored';
  }

  await upsertPaymentFromEvent(ctx.db, order, event, ctx.payment.name);

  switch (event.type) {
    case 'payment.succeeded': {
      // Guard against an underpayment being treated as settlement. Providers
      // report the captured amount; if it does not cover the order we flag it
      // for a human rather than shipping goods that were not paid for.
      if (event.amountPaise !== null && event.amountPaise < order.total_paise) {
        log.alert('payment.amount_mismatch', {
          orderId: order.id,
          expectedPaise: order.total_paise,
          receivedPaise: event.amountPaise,
        });
        await ctx.db.batch([
          orderEventStatement(ctx.db, {
            orderId: order.id,
            type: 'payment.amount_mismatch',
            message: `Provider reported ${formatPaise(event.amountPaise)} against an order total of ${formatPaise(order.total_paise)}. Held for review.`,
            actorType: 'provider',
            customerVisible: false,
          }),
        ]);
        return 'processed';
      }

      const { alreadyConfirmed } = await confirmOrder(ctx.db, order.id, { paymentStatus: 'paid' });
      if (!alreadyConfirmed) {
        const { onOrderConfirmed } = await import('./order-notifications');
        await onOrderConfirmed(ctx, order.id);
      }
      return 'processed';
    }

    case 'payment.failed': {
      if (order.status === 'pending_payment' || order.status === 'payment_failed') {
        await transitionOrder(ctx.db, {
          orderId: order.id,
          to: 'payment_failed',
          message: event.failureReason
            ? `Payment did not go through: ${event.failureReason}`
            : 'Payment did not go through.',
          actorType: 'provider',
        });
        await ctx.db.run("UPDATE orders SET payment_status = 'failed', updated_at = ? WHERE id = ?", [
          Date.now(),
          order.id,
        ]);
        const { onPaymentFailed } = await import('./order-notifications');
        await onPaymentFailed(ctx, order.id);
      }
      return 'processed';
    }

    case 'payment.cancelled': {
      // The customer walked away from the payment page. Leave the order alone —
      // the reservation sweeper will clean it up if they never come back, and
      // cancelling here would break the "retry payment" link in their email.
      await ctx.db.batch([
        orderEventStatement(ctx.db, {
          orderId: order.id,
          type: 'payment.cancelled',
          message: 'Payment was cancelled at the gateway.',
          actorType: 'provider',
          customerVisible: false,
        }),
      ]);
      return 'processed';
    }

    case 'payment.refunded': {
      const amount = event.amountPaise ?? order.total_paise;
      await recordRefund(ctx, order, amount, 'Refunded at the payment provider', null, event.providerPaymentId);
      return 'processed';
    }

    default:
      return 'ignored';
  }
}

/** Find the order an event belongs to, by metadata id first then by checkout id. */
async function resolveOrder(db: Db, event: PaymentWebhookEvent): Promise<OrderRow | null> {
  if (event.orderId) {
    const byId = await getOrderById(db, event.orderId);
    if (byId) return byId;
  }
  if (event.providerCheckoutId) {
    const payment = await db.first<PaymentRow>(
      'SELECT * FROM payments WHERE provider_checkout_id = ? ORDER BY created_at DESC LIMIT 1',
      [event.providerCheckoutId],
    );
    if (payment) return getOrderById(db, payment.order_id);
  }
  return null;
}

async function upsertPaymentFromEvent(
  db: Db,
  order: OrderRow,
  event: PaymentWebhookEvent,
  providerName: string,
): Promise<void> {
  const now = Date.now();
  const status =
    event.type === 'payment.succeeded'
      ? 'paid'
      : event.type === 'payment.failed'
        ? 'failed'
        : event.type === 'payment.cancelled'
          ? 'cancelled'
          : event.type === 'payment.refunded'
            ? 'refunded'
            : 'pending';

  const existing = event.providerCheckoutId
    ? await db.first<PaymentRow>('SELECT * FROM payments WHERE provider_checkout_id = ? LIMIT 1', [
        event.providerCheckoutId,
      ])
    : null;

  if (existing) {
    await db.run(
      `UPDATE payments SET status = ?, provider_payment_id = COALESCE(?, provider_payment_id),
              provider_customer_id = COALESCE(?, provider_customer_id), method = COALESCE(?, method),
              failure_reason = ?, captured_at = CASE WHEN ? = 'paid' THEN COALESCE(captured_at, ?) ELSE captured_at END,
              updated_at = ? WHERE id = ?`,
      [
        status,
        event.providerPaymentId,
        event.providerCustomerId,
        event.method,
        event.failureReason ?? null,
        status,
        now,
        now,
        existing.id,
      ],
    );
    return;
  }

  // No local record — a payment completed outside our checkout flow (a resent
  // provider link, or an operator collecting manually). Record it so the order
  // has a payment trail rather than dropping the fact on the floor.
  await db.run(
    `INSERT INTO payments (id, order_id, provider, provider_checkout_id, provider_payment_id, provider_customer_id,
                           status, amount_paise, currency, method, raw_json, created_at, updated_at, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('pay'),
      order.id,
      providerName,
      event.providerCheckoutId,
      event.providerPaymentId,
      event.providerCustomerId,
      status,
      event.amountPaise ?? order.total_paise,
      event.currency ?? order.currency,
      event.method,
      JSON.stringify(event.raw).slice(0, 4000),
      now,
      now,
      status === 'paid' ? now : null,
    ],
  );
}

// ─── Refunds ─────────────────────────────────────────────────────────────────

export interface RefundResult {
  refundId: string;
  amountPaise: number;
  status: 'pending' | 'completed' | 'failed';
}

/**
 * Refund through the provider, then record it. If the provider call fails
 * nothing is written — a refund the customer never received must not appear in
 * our books as issued.
 */
export async function refundOrder(
  ctx: AppContext,
  orderId: string,
  opts: { amountPaise?: number; reason?: string; actorId: string },
): Promise<RefundResult> {
  const order = await getOrderById(ctx.db, orderId);
  if (!order) throw notFound('We could not find that order.');
  if (order.payment_status !== 'paid' && order.payment_status !== 'partially_refunded') {
    throw conflict('That order has no captured payment to refund.');
  }

  const remaining = order.total_paise - order.refunded_paise;
  const amount = Math.min(opts.amountPaise ?? remaining, remaining);
  if (amount <= 0) throw conflict('That order has already been refunded in full.');

  const payment = await ctx.db.first<PaymentRow>(
    "SELECT * FROM payments WHERE order_id = ? AND status IN ('paid','partially_refunded') ORDER BY created_at DESC LIMIT 1",
    [orderId],
  );
  if (!payment?.provider_payment_id && !payment?.provider_checkout_id) {
    throw conflict('That order has no provider payment reference to refund against.');
  }

  let outcome;
  try {
    outcome = await ctx.payment.refund({
      providerPaymentId: payment.provider_payment_id ?? (payment.provider_checkout_id as string),
      amountPaise: amount,
      reason: opts.reason,
    });
  } catch (err) {
    log.error('payments.refund_failed', { orderId, amountPaise: amount, error: errMessage(err) });
    throw providerError('The payment provider rejected that refund. Nothing was charged back.', err);
  }

  const recorded = await recordRefund(
    ctx,
    order,
    outcome.amountPaise,
    opts.reason ?? 'Refund issued',
    opts.actorId,
    payment.provider_payment_id,
    { providerRefundId: outcome.providerRefundId, status: outcome.status, paymentId: payment.id },
  );

  const { onRefundIssued } = await import('./order-notifications');
  await onRefundIssued(ctx, orderId, outcome.amountPaise);

  return recorded;
}

/**
 * Persist a refund and roll the order's payment status forward. Shared by the
 * admin-initiated path and the provider-initiated webhook path so both produce
 * identical bookkeeping.
 */
async function recordRefund(
  ctx: AppContext,
  order: OrderRow,
  amountPaise: number,
  reason: string,
  actorId: string | null,
  providerPaymentId: string | null,
  provider?: { providerRefundId: string; status: 'pending' | 'completed' | 'failed'; paymentId: string | null },
): Promise<RefundResult> {
  const now = Date.now();
  const refundId = newId('ref');
  const alreadyRefunded = order.refunded_paise;
  const totalRefunded = Math.min(order.total_paise, alreadyRefunded + amountPaise);
  const fullyRefunded = totalRefunded >= order.total_paise;

  await ctx.db.batch([
    ctx.db.stmt(
      `INSERT INTO refunds (id, order_id, payment_id, provider, provider_refund_id, amount_paise, status,
                            reason, actor_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        refundId,
        order.id,
        provider?.paymentId ?? null,
        ctx.payment.name,
        provider?.providerRefundId ?? providerPaymentId,
        amountPaise,
        provider?.status ?? 'completed',
        reason.slice(0, 300),
        actorId,
        now,
        now,
      ],
    ),
    ctx.db.stmt(
      `UPDATE orders SET refunded_paise = ?, payment_status = ?, status = CASE WHEN ? = 1 THEN 'refunded' ELSE status END,
              updated_at = ? WHERE id = ?`,
      [totalRefunded, fullyRefunded ? 'refunded' : 'partially_refunded', fullyRefunded ? 1 : 0, now, order.id],
    ),
    orderEventStatement(ctx.db, {
      orderId: order.id,
      type: 'payment.refunded',
      message: `${formatPaise(amountPaise)} refunded. ${reason}`.trim(),
      data: { amountPaise, totalRefundedPaise: totalRefunded },
      actorType: actorId ? 'admin' : 'provider',
      actorId,
    }),
  ]);

  // A fully refunded order that never shipped puts its stock back.
  if (fullyRefunded && ['confirmed', 'processing', 'packed'].includes(order.status)) {
    const lines = await orderStockLines(ctx.db, order.id);
    await ctx.db.batch(
      lines.flatMap((line) => [
        ctx.db.stmt('UPDATE inventory SET on_hand = on_hand + ?, updated_at = ? WHERE variant_id = ?', [
          line.qty,
          now,
          line.variantId,
        ]),
        ctx.db.stmt(
          `INSERT INTO inventory_ledger (id, variant_id, delta, reason, ref_type, ref_id, note, actor_id, created_at)
           VALUES (?, ?, ?, 'return', 'order', ?, 'Full refund', ?, ?)`,
          [newId('inv'), line.variantId, line.qty, order.id, actorId ?? 'system', now],
        ),
      ]),
    );
  }

  log.info('payments.refund_recorded', { orderId: order.id, amountPaise, fullyRefunded });
  return { refundId, amountPaise, status: provider?.status ?? 'completed' };
}

/** Release stock for an order whose payment we know will never arrive. */
export async function abandonUnpaidOrder(ctx: AppContext, orderId: string, reason: string): Promise<void> {
  const lines = await orderStockLines(ctx.db, orderId);
  await releaseReservation(ctx.db, lines, orderId);
  await ctx.db.batch([
    ctx.db.stmt(
      `UPDATE orders SET status = 'cancelled', cancel_reason = ?, cancelled_at = ?, reserved_until = NULL,
              updated_at = ? WHERE id = ? AND status IN ('pending_payment','payment_failed')`,
      [reason.slice(0, 300), Date.now(), Date.now(), orderId],
    ),
  ]);
}
