/**
 * Provider callbacks: replays, forgeries and short payments.
 *
 * Gateways retry. A retry storm that confirms an order twice would decrement
 * stock twice and mail the customer two receipts, so there are two independent
 * defences and both are tested here: the UNIQUE (provider, event_id) insert that
 * makes a repeat delivery a no-op, and `confirmOrder` itself refusing to act on
 * an order that has already left `pending_payment`.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { PaymentWebhookEvent } from '../../src/lib/providers/payment/types';
import type { MockPaymentProvider } from '../../src/lib/providers/payment/mock';
import type { MockShipmentProvider } from '../../src/lib/providers/shipping/mock';
import { hmacSha256Hex } from '../../src/lib/crypto';
import { confirmOrder } from '../../src/lib/services/orders';
import { handlePaymentWebhook, startPayment } from '../../src/lib/services/payments';
import { createShipmentForOrder, handleShipmentWebhook } from '../../src/lib/services/shipments';
import {
  SEED,
  TEST_SESSION_SECRET,
  addToCart,
  createCart,
  createContext,
  db,
  flushWaitUntil,
  freshDatabase,
  inventoryOf,
  orderEventTypes,
  outboxTemplates,
  placeOrder,
  reloadOrder,
} from '../setup';

const LARGE = SEED.pickle.large.id; // ₹549, 10 on hand

beforeEach(freshDatabase);

/** An order awaiting payment, with a mock gateway transaction open against it. */
async function orderAwaitingPayment(qty = 2) {
  const ctx = createContext();
  const cartId = await createCart();
  await addToCart(cartId, LARGE, qty);
  const { order } = await placeOrder(ctx, { cartId });
  const started = await startPayment(ctx, order);
  return { ctx, order, started, provider: ctx.payment as MockPaymentProvider };
}

function signedHeaders(headerName: string, signatureHeader: string): Headers {
  return new Headers({ [headerName]: signatureHeader, 'content-type': 'application/json' });
}

describe('a replayed payment webhook', () => {
  it('is recognised as a duplicate and changes nothing the second time', async () => {
    const { ctx, order, started, provider } = await orderAwaitingPayment();

    const simulated = await provider.simulate(started.providerCheckoutId, 'success', 'upi');
    const event = await ctx.payment.verifyAndParseWebhook(
      simulated.body,
      signedHeaders(simulated.headerName, simulated.signatureHeader),
    );

    const first = await handlePaymentWebhook(ctx, event, true);
    await flushWaitUntil(ctx);
    expect(first.outcome).toBe('processed');
    expect((await reloadOrder(order.id)).status).toBe('confirmed');
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 8, reserved: 0 });

    // The gateway sends the identical event again, twice more.
    const second = await handlePaymentWebhook(ctx, event, true);
    const third = await handlePaymentWebhook(ctx, event, true);
    await flushWaitUntil(ctx);

    expect(second.outcome).toBe('duplicate');
    expect(third.outcome).toBe('duplicate');

    // Not 6. Stock is decremented once per payment, not once per delivery.
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 8, reserved: 0 });
    expect((await orderEventTypes(order.id)).filter((t) => t === 'order.confirmed')).toHaveLength(1);
    expect(await outboxTemplates(order.id)).toHaveLength(2); // receipt + kitchen copy
    expect(await db.scalar<number>('SELECT COUNT(*) FROM webhook_events')).toBe(1);
  });

  it('holds the line even when the retry carries a fresh event id', async () => {
    const { ctx, order, started, provider } = await orderAwaitingPayment();

    const first = await provider.simulate(started.providerCheckoutId, 'success', 'upi');
    const firstEvent = await ctx.payment.verifyAndParseWebhook(
      first.body,
      signedHeaders(first.headerName, first.signatureHeader),
    );
    await handlePaymentWebhook(ctx, firstEvent, true);
    await flushWaitUntil(ctx);

    // A second, genuinely distinct delivery for the same transaction. The
    // webhook_events dedupe cannot help here — `confirmOrder` has to notice the
    // order already left `pending_payment`.
    const second = await provider.simulate(started.providerCheckoutId, 'success', 'upi');
    const secondEvent = await ctx.payment.verifyAndParseWebhook(
      second.body,
      signedHeaders(second.headerName, second.signatureHeader),
    );
    expect(secondEvent.eventId).not.toBe(firstEvent.eventId);

    const outcome = await handlePaymentWebhook(ctx, secondEvent, true);
    await flushWaitUntil(ctx);

    expect(outcome.outcome).toBe('processed');
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 8, reserved: 0 });
    expect((await orderEventTypes(order.id)).filter((t) => t === 'order.confirmed')).toHaveLength(1);
    expect(await outboxTemplates(order.id)).toHaveLength(2);
    expect(await db.scalar<number>('SELECT COUNT(*) FROM webhook_events')).toBe(2);
  });

  it('does not re-confirm an order a human already confirmed', async () => {
    const { ctx, order, started, provider } = await orderAwaitingPayment();
    await confirmOrder(db, order.id);
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 8, reserved: 0 });

    const simulated = await provider.simulate(started.providerCheckoutId, 'success', 'upi');
    const event = await ctx.payment.verifyAndParseWebhook(
      simulated.body,
      signedHeaders(simulated.headerName, simulated.signatureHeader),
    );
    await handlePaymentWebhook(ctx, event, true);
    await flushWaitUntil(ctx);

    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 8, reserved: 0 });
    expect(await outboxTemplates(order.id)).toEqual([]);
  });
});

describe('a badly signed payment webhook', () => {
  it('is rejected when the signature header is missing', async () => {
    const { ctx, started, provider } = await orderAwaitingPayment();
    const simulated = await provider.simulate(started.providerCheckoutId, 'success');

    await expect(ctx.payment.verifyAndParseWebhook(simulated.body, new Headers())).rejects.toThrow(
      'missing signature header',
    );
  });

  it('is rejected when the header is malformed', async () => {
    const { ctx, started, provider } = await orderAwaitingPayment();
    const simulated = await provider.simulate(started.providerCheckoutId, 'success');

    await expect(
      ctx.payment.verifyAndParseWebhook(simulated.body, signedHeaders(simulated.headerName, 'garbage')),
    ).rejects.toThrow('malformed signature header');
  });

  it('is rejected when the body has been tampered with', async () => {
    const { ctx, order, started, provider } = await orderAwaitingPayment();
    const simulated = await provider.simulate(started.providerCheckoutId, 'success');

    // Someone tries to mark a ₹1,098 order paid for ₹1.
    const forged = simulated.body.replace(/"amount_paise":\d+/, '"amount_paise":100');
    expect(forged).not.toBe(simulated.body);

    await expect(
      ctx.payment.verifyAndParseWebhook(forged, signedHeaders(simulated.headerName, simulated.signatureHeader)),
    ).rejects.toThrow('signature mismatch');

    // Nothing reached the order, because the route never gets an event to apply.
    expect((await reloadOrder(order.id)).status).toBe('pending_payment');
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 10, reserved: 2 });
  });

  it('is rejected when it was signed with the wrong secret', async () => {
    const { started, provider } = await orderAwaitingPayment();
    const simulated = await provider.simulate(started.providerCheckoutId, 'success');

    const otherStore = createContext({ env: { SESSION_SECRET: 'a-completely-different-secret-value' } });
    await expect(
      otherStore.payment.verifyAndParseWebhook(
        simulated.body,
        signedHeaders(simulated.headerName, simulated.signatureHeader),
      ),
    ).rejects.toThrow('signature mismatch');
  });

  it('is rejected when the timestamp is outside the replay window', async () => {
    const { ctx, started, provider } = await orderAwaitingPayment();
    const simulated = await provider.simulate(started.providerCheckoutId, 'success');

    // Correctly signed, but for a timestamp an hour ago — a captured payload
    // being replayed later must not be accepted.
    const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
    const staleSignature = await hmacSha256Hex(TEST_SESSION_SECRET, `${staleTs}:${simulated.body}`);

    await expect(
      ctx.payment.verifyAndParseWebhook(
        simulated.body,
        signedHeaders(simulated.headerName, `ts=${staleTs};h1=${staleSignature}`),
      ),
    ).rejects.toThrow('timestamp out of range');
  });
});

describe('an underpaying payment webhook', () => {
  it('does not confirm the order, and flags it for a human', async () => {
    const { ctx, order, started, provider } = await orderAwaitingPayment();
    expect(order.total_paise).toBe(109_800);

    const simulated = await provider.simulate(started.providerCheckoutId, 'success', 'upi');
    // The operator-replay parser, so this is a genuinely short payment reported
    // by the provider rather than a forged body.
    const short = simulated.body.replace(/"amount_paise":\d+/, '"amount_paise":100');
    const event: PaymentWebhookEvent = await ctx.payment.parseTrustedWebhook(short);
    expect(event.amountPaise).toBe(100);

    const result = await handlePaymentWebhook(ctx, event, true);
    await flushWaitUntil(ctx);

    // Recorded and handled — but not treated as settlement.
    expect(result.outcome).toBe('processed');

    const after = await reloadOrder(order.id);
    expect(after).toMatchObject({ status: 'pending_payment', payment_status: 'pending', paid_at: null });

    // Stock is still only held; nothing has been sold on the strength of ₹1.
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 10, reserved: 2 });

    expect(await orderEventTypes(order.id)).toContain('payment.amount_mismatch');
    expect(await outboxTemplates(order.id)).toEqual([]);
  });

  it('accepts a payment that covers the order exactly, or more', async () => {
    const { ctx, order, started, provider } = await orderAwaitingPayment();
    const simulated = await provider.simulate(started.providerCheckoutId, 'success', 'upi');
    const over = simulated.body.replace(/"amount_paise":\d+/, `"amount_paise":${order.total_paise + 1}`);

    await handlePaymentWebhook(ctx, await ctx.payment.parseTrustedWebhook(over), true);
    await flushWaitUntil(ctx);

    expect((await reloadOrder(order.id)).status).toBe('confirmed');
  });

  it('accepts an event that reports no amount at all', async () => {
    const { ctx, order, started, provider } = await orderAwaitingPayment();
    const simulated = await provider.simulate(started.providerCheckoutId, 'success', 'upi');
    const silent = simulated.body.replace(/"amount_paise":\d+/, '"amount_paise":null');

    const event = await ctx.payment.parseTrustedWebhook(silent);
    expect(event.amountPaise).toBeNull();

    await handlePaymentWebhook(ctx, event, true);
    await flushWaitUntil(ctx);
    expect((await reloadOrder(order.id)).status).toBe('confirmed');
  });
});

describe('other payment outcomes', () => {
  it('marks a failed payment as retryable and keeps the stock held', async () => {
    const { ctx, order, started, provider } = await orderAwaitingPayment();
    const simulated = await provider.simulate(started.providerCheckoutId, 'failure');
    const event = await ctx.payment.verifyAndParseWebhook(
      simulated.body,
      signedHeaders(simulated.headerName, simulated.signatureHeader),
    );

    await handlePaymentWebhook(ctx, event, true);
    await flushWaitUntil(ctx);

    expect(await reloadOrder(order.id)).toMatchObject({ status: 'payment_failed', payment_status: 'failed' });
    // The customer can still pay on a second attempt, so their jars stay held.
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 10, reserved: 2 });
    expect(await outboxTemplates(order.id)).toEqual(['order_payment_failed']);
  });

  it('leaves an abandoned payment alone for the reservation sweeper', async () => {
    const { ctx, order, started, provider } = await orderAwaitingPayment();
    const simulated = await provider.simulate(started.providerCheckoutId, 'cancel');
    const event = await ctx.payment.verifyAndParseWebhook(
      simulated.body,
      signedHeaders(simulated.headerName, simulated.signatureHeader),
    );

    await handlePaymentWebhook(ctx, event, true);
    await flushWaitUntil(ctx);

    // Cancelling here would break the "try paying again" link in their email.
    expect((await reloadOrder(order.id)).status).toBe('pending_payment');
    expect(await inventoryOf(LARGE)).toMatchObject({ reserved: 2 });
    expect(await orderEventTypes(order.id)).toContain('payment.cancelled');
  });

  it('ignores an event type it does not model', async () => {
    const ctx = createContext();
    const event = await ctx.payment.parseTrustedWebhook(
      JSON.stringify({ event_id: 'evt_unknown_1', event_type: 'subscription.updated', data: {} }),
    );
    expect(event.type).toBe('unknown');

    const result = await handlePaymentWebhook(ctx, event, true);
    expect(result.outcome).toBe('ignored');
    expect(
      await db.scalar<string>("SELECT status FROM webhook_events WHERE event_id = 'evt_unknown_1'"),
    ).toBe('ignored');
  });

  it('ignores an event it cannot attribute to an order', async () => {
    const ctx = createContext();
    const event = await ctx.payment.parseTrustedWebhook(
      JSON.stringify({
        event_id: 'evt_orphan_1',
        event_type: 'transaction.completed',
        data: { order_id: 'ord_never_existed', amount_paise: 10_000 },
      }),
    );

    const result = await handlePaymentWebhook(ctx, event, true);
    expect(result.outcome).toBe('ignored');
  });

  it('records that a signature failed verification when it is told so', async () => {
    const ctx = createContext();
    const event = await ctx.payment.parseTrustedWebhook(
      JSON.stringify({ event_id: 'evt_unsigned_1', event_type: 'subscription.updated', data: {} }),
    );

    await handlePaymentWebhook(ctx, event, false);
    expect(
      await db.scalar<number>("SELECT signature_valid FROM webhook_events WHERE event_id = 'evt_unsigned_1'"),
    ).toBe(0);
  });
});

describe('courier webhooks', () => {
  it('treats a repeated scan as a duplicate', async () => {
    const { ctx, order, started, provider } = await orderAwaitingPayment(1);
    const simulated = await provider.simulate(started.providerCheckoutId, 'success', 'upi');
    await handlePaymentWebhook(
      ctx,
      await ctx.payment.verifyAndParseWebhook(
        simulated.body,
        signedHeaders(simulated.headerName, simulated.signatureHeader),
      ),
      true,
    );
    await flushWaitUntil(ctx);

    const shipment = await createShipmentForOrder(ctx, order.id, { actorId: 'usr_admin' });
    await flushWaitUntil(ctx);

    const courier = ctx.shipping as MockShipmentProvider;
    const advanced = await courier.advance(shipment.provider_shipment_id as string, 'out_for_delivery');
    expect(advanced).not.toBeNull();
    if (!advanced) return;

    const event = await ctx.shipping.verifyAndParseWebhook(
      advanced.body,
      signedHeaders(advanced.headerName, advanced.signatureHeader),
    );

    expect((await handleShipmentWebhook(ctx, event)).outcome).toBe('processed');
    await flushWaitUntil(ctx);
    expect((await handleShipmentWebhook(ctx, event)).outcome).toBe('duplicate');
    await flushWaitUntil(ctx);

    expect((await reloadOrder(order.id)).status).toBe('out_for_delivery');
    // One scan recorded, one "out for delivery" mail sent.
    expect(
      await db.scalar<number>("SELECT COUNT(*) FROM shipment_events WHERE status = 'out_for_delivery'"),
    ).toBe(1);
    expect((await outboxTemplates(order.id)).filter((t) => t === 'order_out_for_delivery')).toHaveLength(1);
  });

  it('rejects a courier callback with a bad signature', async () => {
    const ctx = createContext();
    const body = JSON.stringify({ event_id: 'ship_evt_1', awb: 'MGS123', status: 'delivered' });
    const ts = Math.floor(Date.now() / 1000).toString();
    const wrong = await hmacSha256Hex('not-the-secret', `${ts}:${body}`);

    await expect(
      ctx.shipping.verifyAndParseWebhook(body, signedHeaders('x-mgs-mock-signature', `ts=${ts};h1=${wrong}`)),
    ).rejects.toThrow('signature mismatch');
  });

  it('ignores a scan for a parcel it does not know', async () => {
    const ctx = createContext();
    const body = JSON.stringify({
      event_id: 'ship_evt_orphan',
      awb: 'MGS000000000',
      status: 'in_transit',
      description: 'In transit',
      occurred_at: Date.now(),
    });
    const ts = Math.floor(Date.now() / 1000).toString();
    const signature = await hmacSha256Hex(TEST_SESSION_SECRET, `${ts}:${body}`);
    const event = await ctx.shipping.verifyAndParseWebhook(
      body,
      signedHeaders('x-mgs-mock-signature', `ts=${ts};h1=${signature}`),
    );

    expect(await handleShipmentWebhook(ctx, event)).toEqual({ outcome: 'ignored', orderId: null });
    expect(await db.scalar<string>("SELECT status FROM webhook_events WHERE event_id = 'ship_evt_orphan'")).toBe(
      'ignored',
    );
  });
});
