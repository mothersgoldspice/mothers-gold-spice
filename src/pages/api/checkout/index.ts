/**
 * Place an order.
 *
 * The single most consequential endpoint in the system, so the ordering of steps
 * is deliberate:
 *
 *   validate → resolve identity → verify we can deliver there → build the order
 *   (which reserves stock) → hand off to payment
 *
 * Stock is reserved as part of order creation and released automatically if the
 * customer never pays. Nothing here trusts a price, a total or a discount sent
 * by the browser — the only client-supplied numbers are quantities, and those
 * were already written to the cart under their own validation.
 */

import type { APIRoute } from 'astro';
import { rateKey, requireCtx } from '../../../lib/api';
import { conflict } from '../../../lib/errors';
import { siteUrl } from '../../../lib/env';
import { handle, ok, readJson } from '../../../lib/http';
import { log } from '../../../lib/log';
import { RATE_LIMITS, enforceRateLimit } from '../../../lib/rate-limit';
import { startSession } from '../../../lib/auth/session';
import { ensureGuestUser, getAddress, registerUser, saveAddress } from '../../../lib/services/accounts';
import { getCart } from '../../../lib/services/cart';
import { onOrderConfirmed } from '../../../lib/services/order-notifications';
import { createOrder } from '../../../lib/services/orders';
import { confirmCodOrder, startPayment } from '../../../lib/services/payments';
import { checkServiceability } from '../../../lib/services/shipments';
import { zoneForPincode } from '../../../lib/shipping-zones';
import { checkoutSchema, parseOrThrow } from '../../../lib/validate';
import type { AddressSnapshot } from '../../../lib/db/types';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request, cookies }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    await enforceRateLimit(ctx.db, rateKey(ctx, 'checkout'), RATE_LIMITS.checkout);

    const input = parseOrThrow(checkoutSchema, await readJson(request));
    const settings = await ctx.settings();
    if (!settings.storeOpen) throw conflict(settings.storeClosedMessage);

    // Idempotency is checked FIRST, before anything else looks at the cart.
    // Placing an order marks its cart `converted`, so a replayed request would
    // otherwise read an empty cart and be rejected with "your cart is empty" —
    // which is exactly the confusing failure a double-tapped Place Order button
    // produces. Short-circuiting here returns the order that already exists.
    if (input.idempotency_key) {
      const existing = await ctx.db.first<{ id: string; order_number: string; payment_method: string }>(
        'SELECT id, order_number, payment_method FROM orders WHERE idempotency_key = ?',
        [input.idempotency_key],
      );
      if (existing) {
        log.info('checkout.idempotent_replay', { orderId: existing.id });
        const payment = await ctx.db.first<{ checkout_url: string | null }>(
          `SELECT checkout_url FROM payments WHERE order_id = ? AND status = 'pending' AND checkout_url IS NOT NULL
            ORDER BY created_at DESC LIMIT 1`,
          [existing.id],
        );
        return ok({
          orderId: existing.id,
          orderNumber: existing.order_number,
          paymentRequired: existing.payment_method !== 'cod',
          // Send them back to the same gateway session rather than opening a
          // second one for the same money.
          checkoutUrl: payment?.checkout_url ?? undefined,
          redirectUrl: `/checkout/return?order=${encodeURIComponent(existing.id)}`,
        });
      }
    }

    // ── Address ─────────────────────────────────────────────────────────────
    // A saved address is re-read from the database rather than trusted from the
    // request, so a tampered address_id cannot ship someone else's order here.
    const shippingInput = input.address_id && ctx.user ? await getAddress(ctx.db, ctx.user.id, input.address_id) : null;

    const shippingAddress: AddressSnapshot = shippingInput
      ? {
          full_name: shippingInput.full_name,
          phone: shippingInput.phone,
          email: input.email,
          line1: shippingInput.line1,
          line2: shippingInput.line2,
          landmark: shippingInput.landmark,
          city: shippingInput.city,
          state: shippingInput.state,
          pincode: shippingInput.pincode,
          country: shippingInput.country,
        }
      : { ...input.shipping_address, email: input.email };

    const billingAddress: AddressSnapshot = input.billing_same_as_shipping
      ? shippingAddress
      : { ...(input.billing_address ?? input.shipping_address), email: input.email };

    // ── Can we actually deliver there? ──────────────────────────────────────
    const zone = zoneForPincode(shippingAddress.pincode);
    const cartPreview = await getCart(ctx.db, ctx.cartId, settings, {
      zone,
      paymentMethod: input.payment_method,
      userId: ctx.user?.id ?? null,
    });
    if (cartPreview.lines.length === 0) throw conflict('Your cart is empty.');

    const service = await checkServiceability(ctx, shippingAddress.pincode, {
      weightGrams: cartPreview.pricing.weightGrams,
      declaredValuePaise: cartPreview.pricing.subtotalPaise,
      cod: input.payment_method === 'cod',
    });
    if (!service.serviceable) {
      throw conflict(
        `We cannot deliver to ${shippingAddress.pincode} yet. Write to us and we will try to arrange something.`,
      );
    }
    if (input.payment_method === 'cod' && !service.codAvailable) {
      throw conflict('Cash on delivery is not available for that PIN code. Please pay online instead.');
    }

    // ── Identity ────────────────────────────────────────────────────────────
    let userId = ctx.user?.id ?? null;
    let isGuest = !ctx.user;

    if (!ctx.user && input.create_account && input.password) {
      const outcome = await registerUser(ctx.db, {
        name: shippingAddress.full_name,
        email: input.email,
        password: input.password,
        phone: shippingAddress.phone,
      });
      if (outcome.created) {
        userId = outcome.user.id;
        isGuest = false;
        await startSession(ctx.db, cookies, ctx.env, {
          userId: outcome.user.id,
          ip: ctx.clientIp,
          userAgent: request.headers.get('user-agent') ?? '',
        });
      } else {
        // The address is already registered. Continue as a guest rather than
        // blocking the sale — the order still attaches to their existing user
        // row below, so it appears in their history when they next sign in.
        userId = outcome.existingUser.id;
        isGuest = true;
      }
    } else if (!ctx.user) {
      // Guests get a passwordless shell so their order history survives them
      // signing up later with the same address.
      const shell = await ensureGuestUser(ctx.db, input.email, shippingAddress.full_name, shippingAddress.phone);
      userId = shell.id;
      isGuest = true;
    }

    // ── Create ──────────────────────────────────────────────────────────────
    const { order, guestToken, reused } = await createOrder(ctx, {
      cart: cartPreview,
      settings,
      email: input.email,
      customerName: shippingAddress.full_name,
      phone: shippingAddress.phone,
      shippingAddress,
      billingAddress,
      paymentMethod: input.payment_method,
      shippingMethod: input.shipping_method,
      customerNote: input.customer_note ?? null,
      userId,
      isGuest,
      idempotencyKey: input.idempotency_key ?? null,
    });

    if (reused) {
      // Belt and braces: two requests with the same key that raced past the
      // short-circuit above both land here, and only one of them created a row.
      log.info('checkout.idempotent_replay_inner', { orderId: order.id });
      return ok({
        orderId: order.id,
        orderNumber: order.order_number,
        paymentRequired: order.payment_method !== 'cod',
        redirectUrl: `/checkout/return?order=${encodeURIComponent(order.id)}`,
      });
    }

    // Keep the address book in sync for signed-in customers who typed a new one.
    if (ctx.user && !input.address_id) {
      await saveAddress(ctx.db, ctx.user.id, {
        label: 'Home',
        full_name: shippingAddress.full_name,
        phone: shippingAddress.phone,
        line1: shippingAddress.line1,
        line2: shippingAddress.line2 ?? null,
        landmark: shippingAddress.landmark ?? null,
        city: shippingAddress.city,
        state: shippingAddress.state,
        pincode: shippingAddress.pincode,
        country: shippingAddress.country,
      }).catch(() => {
        // A full address book must never fail a paid order.
      });
    }

    // ── Payment ─────────────────────────────────────────────────────────────
    if (input.payment_method === 'cod') {
      await confirmCodOrder(ctx, order);
      await onOrderConfirmed(ctx, order.id);
      return ok({
        orderId: order.id,
        orderNumber: order.order_number,
        paymentRequired: false,
        redirectUrl: `/checkout/confirmed?order=${encodeURIComponent(order.id)}${isGuest ? `&t=${encodeURIComponent(guestToken)}` : ''}`,
      });
    }

    const payment = await startPayment(ctx, order);
    return ok({
      orderId: order.id,
      orderNumber: order.order_number,
      paymentRequired: true,
      checkoutUrl: payment.checkoutUrl,
      provider: payment.provider,
      returnUrl: `${siteUrl(ctx.env)}/checkout/return?order=${encodeURIComponent(order.id)}`,
      guestToken: isGuest ? guestToken : undefined,
    });
  });
