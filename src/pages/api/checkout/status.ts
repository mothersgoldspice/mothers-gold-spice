/**
 * Poll an order's payment state.
 *
 * The buyer almost always lands back on our return page BEFORE the provider's
 * webhook arrives, so the return page cannot conclude anything from the URL it
 * was sent to. It polls this instead, which asks the provider directly when the
 * order is still pending — the provider is the authority on whether money moved,
 * and a `?success=1` parameter is just a string the browser can edit.
 */

import type { APIRoute } from 'astro';
import { requireCtx } from '../../../lib/api';
import { badRequest } from '../../../lib/errors';
import { handle, ok } from '../../../lib/http';
import { errMessage, log } from '../../../lib/log';
import type { PaymentRow } from '../../../lib/db/types';
import { assertOrderAccess, confirmOrder, getOrderById } from '../../../lib/services/orders';
import { onOrderConfirmed } from '../../../lib/services/order-notifications';

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    const orderId = url.searchParams.get('order');
    if (!orderId) throw badRequest('Missing order reference.');

    const order = await getOrderById(ctx.db, orderId);
    if (!order) throw badRequest('We could not find that order.');
    await assertOrderAccess(ctx, order, url.searchParams.get('t'));

    // Already settled — nothing to ask the provider.
    if (order.payment_status === 'paid' || order.status !== 'pending_payment') {
      return ok({
        orderId: order.id,
        orderNumber: order.order_number,
        status: order.status,
        paymentStatus: order.payment_status,
        settled: true,
      });
    }

    const payment = await ctx.db.first<PaymentRow>(
      'SELECT * FROM payments WHERE order_id = ? AND provider_checkout_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
      [order.id],
    );

    if (payment?.provider_checkout_id) {
      try {
        const snapshot = await ctx.payment.getPayment(payment.provider_checkout_id);

        // Belt and braces for a webhook that was lost or delayed: if the
        // provider says paid and the amount covers the order, confirm here too.
        // `confirmOrder` is idempotent, so a webhook arriving later is a no-op.
        if (snapshot.status === 'paid' && snapshot.amountPaise >= order.total_paise) {
          const { alreadyConfirmed } = await confirmOrder(ctx.db, order.id, { paymentStatus: 'paid' });
          if (!alreadyConfirmed) {
            log.info('checkout.confirmed_via_polling', { orderId: order.id });
            await onOrderConfirmed(ctx, order.id);
          }
          const fresh = await getOrderById(ctx.db, order.id);
          return ok({
            orderId: order.id,
            orderNumber: order.order_number,
            status: fresh?.status ?? 'confirmed',
            paymentStatus: fresh?.payment_status ?? 'paid',
            settled: true,
          });
        }

        return ok({
          orderId: order.id,
          orderNumber: order.order_number,
          status: order.status,
          paymentStatus: snapshot.status === 'failed' ? 'failed' : order.payment_status,
          settled: snapshot.status === 'failed' || snapshot.status === 'cancelled',
          providerStatus: snapshot.status,
        });
      } catch (err) {
        // A provider lookup failure must not make the page claim the order
        // failed — report "still waiting" and let the poll continue.
        log.warn('checkout.status_provider_lookup_failed', { orderId: order.id, error: errMessage(err) });
      }
    }

    return ok({
      orderId: order.id,
      orderNumber: order.order_number,
      status: order.status,
      paymentStatus: order.payment_status,
      settled: false,
    });
  });
