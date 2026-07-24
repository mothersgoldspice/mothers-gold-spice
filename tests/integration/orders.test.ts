/**
 * Order creation, the status machine, and what happens to stock along the way.
 *
 * An order is a snapshot: the catalogue can be renamed and repriced tomorrow and
 * the receipt must not change. That is asserted here by editing the catalogue
 * after placement and reading the order back.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { OrderItemRow, OrderStatus } from '../../src/lib/db/types';
import { sha256Hex } from '../../src/lib/crypto';
import { getCart } from '../../src/lib/services/cart';
import {
  canTransition,
  cancelOrder,
  confirmOrder,
  createOrder,
  expireStaleReservations,
  getOrderById,
  guestAccessToken,
  transitionOrder,
} from '../../src/lib/services/orders';
import { zoneForPincode } from '../../src/lib/shipping-zones';
import {
  SEED,
  addToCart,
  availableOf,
  createCart,
  createContext,
  createCoupon,
  createUser,
  db,
  freshDatabase,
  inventoryOf,
  orderEventTypes,
  placeOrder,
  reloadOrder,
  testAddress,
  testSettings,
} from '../setup';

const SMALL = SEED.pickle.small.id; // ₹299, 20 on hand
const LARGE = SEED.pickle.large.id; // ₹549, 10 on hand

beforeEach(freshDatabase);

describe('createOrder', () => {
  it('snapshots the names and prices as they were at placement', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 2);

    const { order } = await placeOrder(ctx, { cartId });

    // The catalogue moves on.
    await db.run("UPDATE products SET name = 'Mango Pickle (2027 batch)' WHERE id = ?", [SEED.pickle.productId]);
    await db.run("UPDATE product_variants SET price_paise = 39900, name = '250 g jar' WHERE id = ?", [SMALL]);

    const items = await db.all<OrderItemRow>('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      variant_id: SMALL,
      product_id: SEED.pickle.productId,
      sku: SEED.pickle.small.sku,
      product_name: 'Mango Mustard Pickle',
      variant_name: '250 g',
      unit_price_paise: 29_900,
      qty: 2,
      subtotal_paise: 59_800,
      discount_paise: 0,
      tax_rate_bps: 1200,
      hsn_code: '20019000',
      weight_grams: 250,
      total_paise: 59_800,
    });
    // 12% inclusive of ₹598.
    expect(items[0].tax_paise).toBe(6407);
  });

  it('recomputes the totals rather than trusting anything client-side', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);

    const { order } = await placeOrder(ctx, { cartId });

    // 320 g jar + 250 g packaging = 570 g → two slabs in zone A.
    expect(order).toMatchObject({
      subtotal_paise: 29_900,
      discount_paise: 0,
      shipping_paise: 7400,
      cod_fee_paise: 0,
      total_paise: 37_300,
      total_weight_grams: 570,
      shipping_zone: 'A',
      status: 'pending_payment',
      payment_status: 'pending',
      fulfillment_status: 'unfulfilled',
      tax_inclusive: 1,
      currency: 'INR',
    });
    expect(order.order_number).toMatch(/^MGS-\d{2}-\d{4}$/);
    expect(order.reserved_until).toBeGreaterThan(order.placed_at);
  });

  it('holds stock without selling it, and marks the cart converted', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, LARGE, 3);

    const { order } = await placeOrder(ctx, { cartId });

    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 10, reserved: 3 });
    expect(await availableOf(LARGE)).toBe(7);

    const cart = await db.first<{ status: string; order_id: string }>(
      'SELECT status, order_id FROM carts WHERE id = ?',
      [cartId],
    );
    expect(cart).toEqual({ status: 'converted', order_id: order.id });
    expect(await orderEventTypes(order.id)).toEqual(['order.placed']);
  });

  it('stores only the hash of the guest tracking token', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);

    const { order, guestToken } = await placeOrder(ctx, { cartId });

    expect(guestToken).toMatch(/^[0-9a-f]{64}$/);
    expect(order.guest_token_hash).toBe(await sha256Hex(guestToken));
    expect(order.guest_token_hash).not.toBe(guestToken);
    // Derived from the order id, so a later request can rebuild the same link.
    expect(await guestAccessToken(ctx.env, order.id)).toBe(guestToken);
  });

  it('records the coupon redemption and bumps its counter', async () => {
    const ctx = createContext();
    const user = await createUser({ email: 'asha@example.com' });
    const cartId = await createCart(user.id);
    await addToCart(cartId, LARGE, 1);
    await createCoupon({ code: 'SAVE10', type: 'percent', value: 1000 });
    await db.run("UPDATE carts SET coupon_code = 'SAVE10' WHERE id = ?", [cartId]);

    const { order } = await placeOrder(ctx, { cartId, userId: user.id, isGuest: false });

    expect(order.coupon_code).toBe('SAVE10');
    expect(order.coupon_id).toBe('cpn_test_save10');
    expect(order.discount_paise).toBe(5490);

    const redemption = await db.first<{ order_id: string; user_id: string; amount_paise: number }>(
      'SELECT order_id, user_id, amount_paise FROM coupon_redemptions',
    );
    expect(redemption).toEqual({ order_id: order.id, user_id: user.id, amount_paise: 5490 });

    const used = await db.scalar<number>('SELECT used_count FROM coupons WHERE code = ?', ['SAVE10']);
    expect(used).toBe(1);
  });

  it('refuses a coupon that stopped applying between the cart and checkout', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, LARGE, 1);
    await createCoupon({ code: 'SAVE10', type: 'percent', value: 1000 });
    await db.run("UPDATE carts SET coupon_code = 'SAVE10' WHERE id = ?", [cartId]);

    const settings = testSettings();
    const cart = await getCart(db, cartId, settings, { zone: 'A' });
    await db.run("UPDATE coupons SET status = 'disabled' WHERE code = 'SAVE10'");

    // Charging more than the cart page promised is worse than failing the tap.
    await expect(
      createOrder(ctx, {
        cart,
        settings,
        email: 'asha@example.com',
        customerName: 'Asha Rao',
        phone: '+919845012345',
        shippingAddress: testAddress(),
        billingAddress: testAddress(),
        paymentMethod: 'prepaid',
        shippingMethod: 'surface',
        userId: null,
        isGuest: true,
      }),
    ).rejects.toThrow('That coupon is no longer available.');

    expect(await db.scalar<number>('SELECT COUNT(*) FROM orders')).toBe(0);
    expect(await inventoryOf(LARGE)).toMatchObject({ reserved: 0 });
  });

  it('refuses an empty cart and a closed store', async () => {
    const ctx = createContext();
    const cartId = await createCart();

    await expect(placeOrder(ctx, { cartId })).rejects.toThrow('Your cart is empty.');

    await addToCart(cartId, SMALL, 1);
    await expect(
      placeOrder(ctx, { cartId, settings: testSettings({ storeOpen: false, storeClosedMessage: 'Between batches.' }) }),
    ).rejects.toThrow('Between batches.');
  });

  it('holds the cash-on-delivery limits', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, LARGE, 10); // ₹5,490 plus the ₹40 fee, over the ₹5,000 ceiling

    await expect(placeOrder(ctx, { cartId, paymentMethod: 'cod' })).rejects.toThrow(
      'Cash on delivery is available up to ₹5000.',
    );

    const offCartId = await createCart();
    await addToCart(offCartId, SMALL, 1);
    await expect(
      placeOrder(ctx, { cartId: offCartId, paymentMethod: 'cod', settings: testSettings({ codEnabled: false }) }),
    ).rejects.toThrow('Cash on delivery is not available right now.');
  });

  it('releases the reservation if the order row cannot be written', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, LARGE, 2);

    const settings = testSettings();
    const cart = await getCart(db, cartId, settings, { zone: 'A' });

    await expect(
      createOrder(ctx, {
        cart,
        settings,
        email: 'asha@example.com',
        customerName: 'Asha Rao',
        phone: '+919845012345',
        shippingAddress: testAddress(),
        billingAddress: testAddress(),
        paymentMethod: 'prepaid',
        shippingMethod: 'surface',
        // A user id with no row behind it: `orders.user_id` is a foreign key, so
        // the INSERT fails — after stock has already been reserved, which is the
        // window the compensation exists for.
        userId: 'usr_deleted_mid_checkout',
        isGuest: false,
      }),
    ).rejects.toThrow(/FOREIGN KEY|constraint/i);

    expect(await db.scalar<number>('SELECT COUNT(*) FROM orders')).toBe(0);

    // The reservation must not be left behind for the 30-minute sweeper.
    expect(await inventoryOf(LARGE)).toMatchObject({ reserved: 0 });
  });
});

describe('idempotency', () => {
  it('returns the same order for a repeated key instead of placing a second one', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, LARGE, 2);

    const settings = testSettings();
    // The same cart view both times: this is a double-tapped Place Order, where
    // the second request is a byte-for-byte repeat of the first.
    const cart = await getCart(db, cartId, settings, { zone: zoneForPincode(testAddress().pincode) });
    const input = {
      cart,
      settings,
      email: 'asha@example.com',
      customerName: 'Asha Rao',
      phone: '+919845012345',
      shippingAddress: testAddress(),
      billingAddress: testAddress(),
      paymentMethod: 'prepaid' as const,
      shippingMethod: 'surface',
      userId: null,
      isGuest: true,
      idempotencyKey: 'idem_double_tap',
    };

    const first = await createOrder(ctx, input);
    const second = await createOrder(ctx, input);

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.order.id).toBe(first.order.id);
    expect(second.order.order_number).toBe(first.order.order_number);
    expect(second.items.map((i) => i.id).sort()).toEqual(first.items.map((i) => i.id).sort());
    // The replay never saw the raw token; it is emailed from the first call.
    expect(second.guestToken).toBe('');

    expect(await db.scalar<number>('SELECT COUNT(*) FROM orders')).toBe(1);
    // And crucially, stock was reserved once.
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 10, reserved: 2 });
  });

  it('treats two different keys as two different orders', async () => {
    const ctx = createContext();
    const cartA = await createCart();
    const cartB = await createCart();
    await addToCart(cartA, SMALL, 1);
    await addToCart(cartB, SMALL, 1);

    const a = await placeOrder(ctx, { cartId: cartA, idempotencyKey: 'idem_a' });
    const b = await placeOrder(ctx, { cartId: cartB, idempotencyKey: 'idem_b' });

    expect(a.order.id).not.toBe(b.order.id);
    expect(a.order.order_number).not.toBe(b.order.order_number);
    expect(await db.scalar<number>('SELECT COUNT(*) FROM orders')).toBe(2);
  });
});

describe('the status machine', () => {
  it('knows which moves are legal', () => {
    expect(canTransition('pending_payment', 'confirmed')).toBe(true);
    expect(canTransition('confirmed', 'shipped')).toBe(true);
    expect(canTransition('shipped', 'delivered')).toBe(true);
    expect(canTransition('payment_failed', 'pending_payment')).toBe(true);
    expect(canTransition('delivered', 'returned')).toBe(true);

    expect(canTransition('confirmed', 'delivered')).toBe(false);
    expect(canTransition('delivered', 'processing')).toBe(false);
    expect(canTransition('delivered', 'shipped')).toBe(false);
    expect(canTransition('cancelled', 'shipped')).toBe(false);
    expect(canTransition('shipped', 'cancelled')).toBe(false);
    expect(canTransition('refunded', 'confirmed')).toBe(false);
    expect(canTransition('pending_payment', 'delivered')).toBe(false);
  });

  it('treats a repeat of the current status as a no-op, not a violation', () => {
    const statuses: OrderStatus[] = ['pending_payment', 'confirmed', 'shipped', 'delivered', 'cancelled'];
    for (const status of statuses) expect(canTransition(status, status)).toBe(true);
  });

  it('refuses an illegal move and leaves the order alone', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);
    const { order } = await placeOrder(ctx, { cartId });
    await confirmOrder(db, order.id);

    await expect(transitionOrder(db, { orderId: order.id, to: 'delivered' })).rejects.toThrow(
      'An order that is confirmed cannot become delivered.',
    );

    expect((await reloadOrder(order.id)).status).toBe('confirmed');
    expect(await orderEventTypes(order.id)).toEqual(['order.placed', 'order.confirmed']);
  });

  it('refuses to walk a delivered parcel backwards', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);
    const { order } = await placeOrder(ctx, { cartId });
    await confirmOrder(db, order.id);
    await transitionOrder(db, { orderId: order.id, to: 'shipped' });
    await transitionOrder(db, { orderId: order.id, to: 'delivered' });

    await expect(transitionOrder(db, { orderId: order.id, to: 'processing' })).rejects.toThrow();
    await expect(transitionOrder(db, { orderId: order.id, to: 'shipped' })).rejects.toThrow();
    expect((await reloadOrder(order.id)).status).toBe('delivered');
  });

  it('stamps the timestamps and fulfilment status that go with a move', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);
    const { order } = await placeOrder(ctx, { cartId });
    await confirmOrder(db, order.id);

    const shipped = await transitionOrder(db, { orderId: order.id, to: 'shipped' });
    expect(shipped.shipped_at).toBeGreaterThan(0);
    expect(shipped.delivered_at).toBeNull();

    const delivered = await transitionOrder(db, { orderId: order.id, to: 'delivered' });
    expect(delivered.delivered_at).toBeGreaterThan(0);
    expect(delivered.fulfillment_status).toBe('fulfilled');
    // The shipped timestamp is not overwritten by a later move.
    expect(delivered.shipped_at).toBe(shipped.shipped_at);
  });

  it('returns the order unchanged when it is already in that status', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);
    const { order } = await placeOrder(ctx, { cartId });

    const same = await transitionOrder(db, { orderId: order.id, to: 'pending_payment' });
    expect(same.updated_at).toBe(order.updated_at);
    expect(await orderEventTypes(order.id)).toEqual(['order.placed']);
  });

  it('reports an unknown order rather than inventing one', async () => {
    await expect(transitionOrder(db, { orderId: 'ord_nope', to: 'confirmed' })).rejects.toThrow(
      'We could not find that order.',
    );
  });
});

describe('confirmOrder', () => {
  it('turns the reservation into a sale exactly once', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, LARGE, 3);
    const { order } = await placeOrder(ctx, { cartId });

    const first = await confirmOrder(db, order.id);
    expect(first.alreadyConfirmed).toBe(false);
    expect(first.order).toMatchObject({ status: 'confirmed', payment_status: 'paid', reserved_until: null });
    expect(first.order.paid_at).toBeGreaterThan(0);
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 7, reserved: 0 });

    const second = await confirmOrder(db, order.id);
    expect(second.alreadyConfirmed).toBe(true);
    // Not 4 — a replayed confirmation must not decrement stock twice.
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 7, reserved: 0 });
  });

  it('leaves payment outstanding for a cash-on-delivery confirmation', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);
    const { order } = await placeOrder(ctx, { cartId, paymentMethod: 'cod' });

    const { order: confirmed } = await confirmOrder(db, order.id, { paymentStatus: 'pending' });
    expect(confirmed).toMatchObject({ status: 'confirmed', payment_status: 'pending', paid_at: null });
  });
});

describe('cancelOrder', () => {
  it('releases a reservation that was never paid for', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, LARGE, 4);
    const { order } = await placeOrder(ctx, { cartId });
    expect(await availableOf(LARGE)).toBe(6);

    const cancelled = await cancelOrder(db, order.id, 'Changed my mind', { type: 'customer', id: null });

    expect(cancelled).toMatchObject({ status: 'cancelled', cancel_reason: 'Changed my mind', reserved_until: null });
    expect(cancelled.cancelled_at).toBeGreaterThan(0);
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 10, reserved: 0 });
    expect(await availableOf(LARGE)).toBe(10);
    // Held stock was never sold, so nothing goes in the ledger.
    expect(await db.scalar<number>('SELECT COUNT(*) FROM inventory_ledger')).toBe(0);
  });

  it('puts sold stock back on the shelf with a ledger trail', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, LARGE, 2);
    const { order } = await placeOrder(ctx, { cartId });
    await confirmOrder(db, order.id);
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 8, reserved: 0 });

    await cancelOrder(db, order.id, 'Out of mustard oil', { type: 'admin', id: 'usr_admin' });

    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 10, reserved: 0 });
    const ledger = await db.all<{ delta: number; reason: string; note: string; actor_id: string }>(
      "SELECT delta, reason, note, actor_id FROM inventory_ledger WHERE reason = 'cancel'",
    );
    expect(ledger).toEqual([{ delta: 2, reason: 'cancel', note: 'Out of mustard oil', actor_id: 'usr_admin' }]);
  });

  it('is idempotent', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, LARGE, 2);
    const { order } = await placeOrder(ctx, { cartId });

    const once = await cancelOrder(db, order.id, 'Changed my mind', { type: 'customer', id: null });
    const twice = await cancelOrder(db, order.id, 'Changed my mind again', { type: 'customer', id: null });

    expect(twice.cancel_reason).toBe(once.cancel_reason);
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 10, reserved: 0 });
    expect((await orderEventTypes(order.id)).filter((t) => t === 'order.cancelled')).toHaveLength(1);
  });

  it('refuses to cancel a parcel that has already gone', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);
    const { order } = await placeOrder(ctx, { cartId });
    await confirmOrder(db, order.id);
    await transitionOrder(db, { orderId: order.id, to: 'shipped' });

    await expect(cancelOrder(db, order.id, 'Too late', { type: 'customer', id: null })).rejects.toThrow(
      'That order has already shipped and can no longer be cancelled here. Please write to us.',
    );
    expect((await reloadOrder(order.id)).status).toBe('shipped');
  });
});

describe('expireStaleReservations', () => {
  it('releases the stock and cancels the order', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, LARGE, 3);
    const { order } = await placeOrder(ctx, { cartId });

    // Wind the hold back rather than waiting 30 minutes: the sweeper reads the
    // column, so the clock never has to move for this to be a real test.
    await db.run('UPDATE orders SET reserved_until = ? WHERE id = ?', [Date.now() - 1000, order.id]);

    expect(await expireStaleReservations(db)).toBe(1);

    const expired = await reloadOrder(order.id);
    expect(expired).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'Payment was not completed in time.',
      reserved_until: null,
    });
    expect(expired.cancelled_at).toBeGreaterThan(0);
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 10, reserved: 0 });
    expect(await orderEventTypes(order.id)).toEqual(['order.placed', 'order.expired']);
  });

  it('leaves a reservation that has not run out alone', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, LARGE, 3);
    const { order } = await placeOrder(ctx, { cartId });

    expect(await expireStaleReservations(db)).toBe(0);
    expect((await reloadOrder(order.id)).status).toBe('pending_payment');
    expect(await inventoryOf(LARGE)).toMatchObject({ reserved: 3 });
  });

  it('never touches an order that was paid for', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, LARGE, 3);
    const { order } = await placeOrder(ctx, { cartId });
    await confirmOrder(db, order.id);
    // Confirmation clears the hold, but force a stale one back to be sure the
    // sweeper is filtering on status and not only on the timestamp.
    await db.run('UPDATE orders SET reserved_until = ? WHERE id = ?', [Date.now() - 1000, order.id]);

    expect(await expireStaleReservations(db)).toBe(0);
    expect((await reloadOrder(order.id)).status).toBe('confirmed');
    expect(await inventoryOf(LARGE)).toMatchObject({ on_hand: 7, reserved: 0 });
  });

  it('sweeps several orders in one pass', async () => {
    const ctx = createContext();
    for (const [i, variant] of [SMALL, LARGE].entries()) {
      const cartId = await createCart();
      await addToCart(cartId, variant, 2);
      const { order } = await placeOrder(ctx, { cartId, idempotencyKey: `idem_${i}` });
      await db.run('UPDATE orders SET reserved_until = ? WHERE id = ?', [Date.now() - 1000, order.id]);
    }

    expect(await expireStaleReservations(db)).toBe(2);
    expect(await inventoryOf(SMALL)).toMatchObject({ reserved: 0 });
    expect(await inventoryOf(LARGE)).toMatchObject({ reserved: 0 });
    expect(await db.scalar<number>("SELECT COUNT(*) FROM orders WHERE status = 'cancelled'")).toBe(2);
  });
});

describe('order numbering', () => {
  it('issues a distinct sequential number per order', async () => {
    const ctx = createContext();
    const numbers: string[] = [];

    for (let i = 0; i < 3; i++) {
      const cartId = await createCart();
      await addToCart(cartId, SMALL, 1);
      const { order } = await placeOrder(ctx, { cartId });
      numbers.push(order.order_number);
    }

    expect(new Set(numbers).size).toBe(3);
    const year = String(new Date().getUTCFullYear()).slice(-2);
    expect(numbers).toEqual([`MGS-${year}-0001`, `MGS-${year}-0002`, `MGS-${year}-0003`]);
  });
});

describe('order access', () => {
  it('finds an order by id', async () => {
    const ctx = createContext();
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);
    const { order } = await placeOrder(ctx, { cartId });

    expect((await getOrderById(db, order.id))?.id).toBe(order.id);
    expect(await getOrderById(db, 'ord_nope')).toBeNull();
  });
});
