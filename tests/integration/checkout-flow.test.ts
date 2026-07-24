/**
 * The whole journey, end to end, against the mock providers.
 *
 * Register → cart → checkout → a signed payment webhook → confirmation → parcel
 * booked → courier scans → delivered. Every provider hop goes through the same
 * `verifyAndParseWebhook` the real route calls, with a signature the mock
 * produced — so what is exercised here is the production code path with a
 * different adapter behind it, not a shortcut around it.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { NotificationRow, PaymentRow, ShipmentEventRow, ShipmentRow } from '../../src/lib/db/types';
import { siteUrl } from '../../src/lib/env';
import { storeContext, verifyEmail } from '../../src/lib/providers/email/templates';
import type { MockPaymentProvider } from '../../src/lib/providers/payment/mock';
import type { MockShipmentProvider } from '../../src/lib/providers/shipping/mock';
import { EMAIL_VERIFY_TTL_MS, registerUser } from '../../src/lib/services/accounts';
import { queueAndSend } from '../../src/lib/services/notify';
import { handlePaymentWebhook, startPayment } from '../../src/lib/services/payments';
import { createShipmentForOrder, handleShipmentWebhook } from '../../src/lib/services/shipments';
import {
  SEED,
  addToCart,
  createCart,
  createContext,
  db,
  flushWaitUntil,
  freshDatabase,
  inventoryOf,
  orderEventTypes,
  outboxRows,
  outboxTemplates,
  placeOrder,
  reloadOrder,
  sessionUser,
} from '../setup';

const SMALL = SEED.pickle.small.id; // ₹299, 20 on hand
const LARGE = SEED.pickle.large.id; // ₹549, 10 on hand

const PASSPHRASE = 'mango pickle in january';

/** Sorted so an assertion never depends on two rows landing in the same millisecond. */
const sorted = (values: string[]): string[] => [...values].sort();

beforeEach(freshDatabase);

describe('a complete order', () => {
  it('goes from sign-up to delivered, mailing the customer at every step', async () => {
    const ctx = createContext();
    const payment = ctx.payment as MockPaymentProvider;
    const courier = ctx.shipping as MockShipmentProvider;

    // ── Register ────────────────────────────────────────────────────────────
    const outcome = await registerUser(db, {
      name: 'Asha Rao',
      email: 'Asha@Example.com',
      password: PASSPHRASE,
      phone: '+919845012345',
    });
    expect(outcome.created).toBe(true);
    if (!outcome.created) throw new Error('registration did not create an account');

    const user = outcome.user;
    expect(user.email).toBe('asha@example.com');
    ctx.user = sessionUser(user);

    const verification = verifyEmail({
      store: storeContext(ctx.env),
      name: user.name,
      verifyUrl: `${siteUrl(ctx.env)}/account/verify?token=${encodeURIComponent(outcome.verificationToken)}`,
      expiresAt: Date.now() + EMAIL_VERIFY_TTL_MS,
    });
    await queueAndSend(ctx, {
      to: user.email,
      toName: user.name,
      subject: verification.subject,
      template: verification.template,
      text: verification.text,
      html: verification.html,
      userId: user.id,
      idempotencyKey: `verify:${user.id}`,
    });
    await flushWaitUntil(ctx);

    expect(await outboxTemplates()).toEqual(['auth_verify_email']);
    expect((await outboxRows())[0]).toMatchObject({ to_email: 'asha@example.com', status: 'sent' });

    // ── Cart ────────────────────────────────────────────────────────────────
    const cartId = await createCart(user.id);
    await addToCart(cartId, SMALL, 1);
    await addToCart(cartId, LARGE, 1);

    // ── Checkout ────────────────────────────────────────────────────────────
    const { order } = await placeOrder(ctx, {
      cartId,
      email: user.email,
      userId: user.id,
      isGuest: false,
    });

    // ₹299 + ₹549 is under the ₹999 threshold, so delivery is charged: 1,190 g
    // across three 500 g slabs into zone A.
    expect(order).toMatchObject({
      subtotal_paise: 84_800,
      shipping_paise: 9900,
      total_paise: 94_700,
      status: 'pending_payment',
      payment_status: 'pending',
      user_id: user.id,
      is_guest: 0,
    });
    // Held, not sold.
    expect(await inventoryOf(SMALL)).toMatchObject({ on_hand: 20, reserved: 1 });
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 10, reserved: 1 });

    const started = await startPayment(ctx, order);
    expect(started.provider).toBe('mock');
    expect(started.checkoutUrl).toBe(`${siteUrl(ctx.env)}/checkout/pay/${started.providerCheckoutId}`);
    expect(await db.first<PaymentRow>('SELECT * FROM payments WHERE id = ?', [started.paymentId])).toMatchObject({
      status: 'pending',
      amount_paise: 94_700,
      provider: 'mock',
    });

    // ── Payment webhook ─────────────────────────────────────────────────────
    const simulated = await payment.simulate(started.providerCheckoutId, 'success', 'upi');
    const event = await ctx.payment.verifyAndParseWebhook(
      simulated.body,
      new Headers({ [simulated.headerName]: simulated.signatureHeader, 'content-type': 'application/json' }),
    );
    expect(event.type).toBe('payment.succeeded');
    expect(event.orderId).toBe(order.id);
    expect(event.amountPaise).toBe(94_700);

    const paymentResult = await handlePaymentWebhook(ctx, event, true);
    await flushWaitUntil(ctx);
    expect(paymentResult).toEqual({ outcome: 'processed', orderId: order.id });

    const confirmed = await reloadOrder(order.id);
    expect(confirmed).toMatchObject({ status: 'confirmed', payment_status: 'paid', reserved_until: null });
    expect(confirmed.paid_at).toBeGreaterThan(0);

    // Stock leaves the shelf only now, when the money has actually arrived.
    expect(await inventoryOf(SMALL)).toMatchObject({ on_hand: 19, reserved: 0 });
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 9, reserved: 0 });

    expect(await db.first<PaymentRow>('SELECT * FROM payments WHERE order_id = ?', [order.id])).toMatchObject({
      status: 'paid',
      method: 'upi',
    });
    expect(sorted(await outboxTemplates(order.id))).toEqual(['admin_new_order', 'order_confirmation']);

    const receipt = (await outboxRows(order.id)).find((r) => r.template === 'order_confirmation');
    expect(receipt).toMatchObject({ to_email: 'asha@example.com', status: 'sent', user_id: user.id });
    expect(receipt?.subject).toContain(order.order_number);
    // A signed-in customer gets an account link, not a guest token in the URL.
    expect(receipt?.text_body).toContain(`/account/orders/${order.id}`);

    // ── Booking the parcel ──────────────────────────────────────────────────
    const shipment = await createShipmentForOrder(ctx, order.id, { actorId: 'usr_admin' });
    await flushWaitUntil(ctx);

    expect(shipment).toMatchObject({ order_id: order.id, provider: 'mock', status: 'created' });
    expect(shipment.awb_code).toMatch(/^MGS\d{11}$/);
    expect(shipment.courier_name).toBeTruthy();
    expect((await reloadOrder(order.id)).status).toBe('shipped');
    expect(sorted(await outboxTemplates(order.id))).toEqual([
      'admin_new_order',
      'order_confirmation',
      'order_shipped',
    ]);

    // ── Courier scans ───────────────────────────────────────────────────────
    const providerShipmentId = shipment.provider_shipment_id as string;
    const scans: string[] = [];

    for (let step = 0; step < 5; step++) {
      const advanced = await courier.advance(providerShipmentId);
      expect(advanced).not.toBeNull();
      if (!advanced) break;

      const trackingEvent = await ctx.shipping.verifyAndParseWebhook(
        advanced.body,
        new Headers({ [advanced.headerName]: advanced.signatureHeader }),
      );
      const result = await handleShipmentWebhook(ctx, trackingEvent);
      await flushWaitUntil(ctx);

      expect(result).toEqual({ outcome: 'processed', orderId: order.id });
      scans.push(trackingEvent.status);
    }

    expect(scans).toEqual(['pickup_scheduled', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered']);

    // ── Delivered ───────────────────────────────────────────────────────────
    const delivered = await reloadOrder(order.id);
    expect(delivered).toMatchObject({ status: 'delivered', fulfillment_status: 'fulfilled' });
    expect(delivered.delivered_at).toBeGreaterThan(0);

    const finalShipment = await db.first<ShipmentRow>('SELECT * FROM shipments WHERE id = ?', [shipment.id]);
    expect(finalShipment).toMatchObject({ status: 'delivered' });
    expect(finalShipment?.delivered_at).toBeGreaterThan(0);

    // One booking scan plus the five the courier sent.
    const shipmentEvents = await db.all<ShipmentEventRow>(
      'SELECT * FROM shipment_events WHERE shipment_id = ? ORDER BY occurred_at, id',
      [shipment.id],
    );
    expect(shipmentEvents).toHaveLength(6);

    // ── The whole mailing history ───────────────────────────────────────────
    expect(sorted(await outboxTemplates(order.id))).toEqual([
      'admin_new_order',
      'order_confirmation',
      'order_delivered',
      'order_out_for_delivery',
      'order_shipped',
    ]);

    // The review request is deliberately held back a day rather than landing
    // while the customer is still holding the parcel.
    const reviewRequest = (await outboxRows(order.id)).find((r) => r.template === 'order_delivered');
    expect(reviewRequest?.status).toBe('queued');
    expect(reviewRequest?.scheduled_at).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);

    // Everything else actually went out.
    const dispatched = (await outboxRows(order.id)).filter((r) => r.template !== 'order_delivered');
    expect(dispatched.map((r) => r.status)).toEqual(['sent', 'sent', 'sent', 'sent']);
    for (const row of dispatched) {
      expect(row.provider).toBe('mock');
      expect(row.provider_message_id).toBeTruthy();
    }

    // ── The customer's timelines ────────────────────────────────────────────
    expect(sorted(await orderEventTypes(order.id))).toEqual([
      'order.confirmed',
      'order.delivered',
      'order.out_for_delivery',
      'order.placed',
      'order.shipped',
      'payment.started',
      'shipment.created',
    ]);

    const notifications = await db.all<NotificationRow>(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at, id',
      [user.id],
    );
    expect(sorted(notifications.map((n) => n.type))).toEqual([
      'order.confirmed',
      'order.delivered',
      'order.shipped',
    ]);

    // ── And the audit trail of what the providers told us ───────────────────
    const webhooks = await db.all<{ source: string; status: string; signature_valid: number }>(
      'SELECT source, status, signature_valid FROM webhook_events ORDER BY received_at, id',
    );
    expect(webhooks).toHaveLength(6); // one payment, five courier scans
    expect(webhooks.every((w) => w.status === 'processed')).toBe(true);
    expect(webhooks.every((w) => w.signature_valid === 1)).toBe(true);
    expect(webhooks.filter((w) => w.source === 'payment')).toHaveLength(1);
  });
});

describe('a guest paying cash on delivery', () => {
  it('confirms without a gateway and still mails the receipt', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 2); // ₹598 — over the ₹299 COD minimum

    const { order, guestToken } = await placeOrder(ctx, {
      cartId,
      paymentMethod: 'cod',
      email: 'guest@example.com',
    });

    const { confirmCodOrder } = await import('../../src/lib/services/payments');
    const { onOrderConfirmed } = await import('../../src/lib/services/order-notifications');
    const confirmed = await confirmCodOrder(ctx, order);
    await onOrderConfirmed(ctx, order.id);
    await flushWaitUntil(ctx);

    // Confirmed, but the money is still outstanding until the door.
    expect(confirmed).toMatchObject({ status: 'confirmed', payment_status: 'pending' });
    expect(confirmed.paid_at).toBeNull();
    expect(order.cod_fee_paise).toBe(4000);

    // The stock is committed all the same — the jars are going out today.
    expect(await inventoryOf(SMALL)).toMatchObject({ on_hand: 18, reserved: 0 });

    expect(sorted(await outboxTemplates(order.id))).toEqual(['admin_new_order', 'order_confirmation']);

    // A guest has no account page, so the receipt carries their signed link.
    const receipt = (await outboxRows(order.id)).find((r) => r.template === 'order_confirmation');
    expect(receipt?.text_body).toContain(`/track/${order.id}?t=${guestToken}`);
  });
});
