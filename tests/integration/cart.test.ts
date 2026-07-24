/**
 * The server-side cart.
 *
 * The cart is the last place a price is still negotiable, so the interesting
 * assertions are about what it refuses: more than the per-variant cap, more than
 * the shelf holds, and a coupon that no longer applies.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  addItem,
  applyCoupon,
  clearCart,
  getCart,
  mergeCarts,
  removeCoupon,
  removeItem,
  updateItem,
} from '../../src/lib/services/cart';
import { reserveStock } from '../../src/lib/services/inventory';
import {
  SEED,
  addToCart,
  createCart,
  createCoupon,
  createUser,
  db,
  freshDatabase,
  testSettings,
} from '../setup';

const SMALL = SEED.pickle.small.id; // ₹299, 20 on hand
const LARGE = SEED.pickle.large.id; // ₹549, 10 on hand
const CHUTNEY = SEED.chutney.jar.id; // ₹249, 4 on hand

const settings = testSettings();

beforeEach(freshDatabase);

describe('adding items', () => {
  it('creates a line, then adds to it', async () => {
    const cartId = await createCart();

    await addToCart(cartId, SMALL, 1);
    let cart = await getCart(db, cartId, settings);
    expect(cart.itemCount).toBe(1);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]).toMatchObject({ variantId: SMALL, qty: 1, unitPricePaise: 29_900, priceChanged: false });

    await addToCart(cartId, SMALL, 2);
    cart = await getCart(db, cartId, settings);
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0].qty).toBe(3);
    expect(cart.pricing.subtotalPaise).toBe(89_700);
  });

  it('keeps separate variants on separate lines', async () => {
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);
    await addToCart(cartId, LARGE, 2);

    const cart = await getCart(db, cartId, settings);
    expect(cart.lines.map((l) => l.variantId)).toEqual([SMALL, LARGE]);
    expect(cart.itemCount).toBe(3);
    expect(cart.pricing.subtotalPaise).toBe(29_900 + 109_800);
  });

  it('caps a first add at the per-variant limit instead of refusing it', async () => {
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 20);

    const cart = await getCart(db, cartId, settings);
    expect(cart.lines[0].qty).toBe(settings.maxQtyPerVariant);
  });

  it('refuses to push a line past the cap once it is there', async () => {
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 12);

    await expect(addToCart(cartId, SMALL, 1)).rejects.toThrow(
      'You can order up to 12 of one jar size per order.',
    );
    const cart = await getCart(db, cartId, settings);
    expect(cart.lines[0].qty).toBe(12);
  });

  it('refuses more than the shelf holds', async () => {
    const cartId = await createCart();
    await expect(addToCart(cartId, CHUTNEY, 5)).rejects.toThrow('Only 4 left of that size.');

    await db.run('UPDATE inventory SET on_hand = 0 WHERE variant_id = ?', [CHUTNEY]);
    await expect(addToCart(cartId, CHUTNEY, 1)).rejects.toThrow('That size just sold out.');
  });

  it('refuses a variant whose product is not on sale', async () => {
    const cartId = await createCart();
    await db.run("UPDATE products SET status = 'draft' WHERE id = ?", [SEED.pickle.productId]);

    await expect(addToCart(cartId, SMALL, 1)).rejects.toThrow('That item is no longer available.');
  });

  it('holds the order-wide unit limit', async () => {
    const capped = testSettings({ maxItemsPerOrder: 5 });
    const cartId = await createCart();

    await addItem(db, cartId, SMALL, 5, capped);
    await expect(addItem(db, cartId, LARGE, 1, capped)).rejects.toThrow('A single order can hold up to 5 jars.');
  });
});

describe('updating and removing', () => {
  it('sets an exact quantity', async () => {
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 3);

    await updateItem(db, cartId, SMALL, 1, settings);
    expect((await getCart(db, cartId, settings)).lines[0].qty).toBe(1);
  });

  it('caps an update at the per-variant limit', async () => {
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);

    await updateItem(db, cartId, SMALL, 99, settings);
    expect((await getCart(db, cartId, settings)).lines[0].qty).toBe(12);
  });

  it('treats a quantity of zero as a removal', async () => {
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 2);

    await updateItem(db, cartId, SMALL, 0, settings);
    expect((await getCart(db, cartId, settings)).lines).toHaveLength(0);
  });

  it('refuses an update that outruns stock', async () => {
    const cartId = await createCart();
    await addToCart(cartId, CHUTNEY, 1);

    await expect(updateItem(db, cartId, CHUTNEY, 5, settings)).rejects.toThrow('Only 4 left of that size.');
    expect((await getCart(db, cartId, settings)).lines[0].qty).toBe(1);
  });

  it('refuses to update a line that is not in the cart', async () => {
    const cartId = await createCart();
    await expect(updateItem(db, cartId, SMALL, 1, settings)).rejects.toThrow('That item is not in your cart.');
  });

  it('removes a line, and removing twice is not an error', async () => {
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);

    await removeItem(db, cartId, SMALL);
    await removeItem(db, cartId, SMALL);
    expect((await getCart(db, cartId, settings)).lines).toHaveLength(0);
  });

  it('clears the lines and the coupon together', async () => {
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);
    await applyCoupon(db, cartId, 'save10');

    await clearCart(db, cartId);
    const cart = await getCart(db, cartId, settings);
    expect(cart.lines).toHaveLength(0);
    expect(cart.couponCode).toBeNull();
  });
});

describe('the cart view', () => {
  it('prices from the catalogue and flags that the price moved', async () => {
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 2);
    await db.run('UPDATE product_variants SET price_paise = ? WHERE id = ?', [31_900, SMALL]);

    const cart = await getCart(db, cartId, settings);
    expect(cart.lines[0]).toMatchObject({
      unitPricePaise: 31_900, // what will actually be charged
      snapshotPricePaise: 29_900, // what it cost when it was added
      priceChanged: true,
      lineTotalPaise: 63_800,
    });
    expect(cart.hasIssues).toBe(true);
  });

  it('flags a line the shelf can no longer cover', async () => {
    const cartId = await createCart();
    await addToCart(cartId, CHUTNEY, 4);
    // Someone else's order takes three of them.
    await reserveStock(db, [{ variantId: CHUTNEY, qty: 3 }], 'ord_other');

    const cart = await getCart(db, cartId, settings);
    expect(cart.lines[0].availabilityIssue).toEqual({ available: 1 });
    expect(cart.hasIssues).toBe(true);
  });

  it('drops a line whose product left the catalogue', async () => {
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);
    await addToCart(cartId, CHUTNEY, 1);
    await db.run("UPDATE products SET status = 'archived' WHERE id = ?", [SEED.chutney.productId]);

    const cart = await getCart(db, cartId, settings);
    expect(cart.lines.map((l) => l.variantId)).toEqual([SMALL]);
  });

  it('prices an unknown or empty cart as an empty cart', async () => {
    const empty = await getCart(db, null, settings);
    expect(empty.lines).toEqual([]);
    expect(empty.pricing.totalPaise).toBe(0);

    const missing = await getCart(db, 'crt_does_not_exist', settings);
    expect(missing.lines).toEqual([]);
    expect(missing.pricing.totalPaise).toBe(0);
  });

  it('leaves shipping out until a zone is known', async () => {
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);

    expect((await getCart(db, cartId, settings)).pricing.shippingPaise).toBe(0);
    expect((await getCart(db, cartId, settings, { zone: 'D' })).pricing.shippingPaise).toBe(14_900);
  });
});

describe('coupon persistence', () => {
  it('stores the code uppercased and applies it on every read', async () => {
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);
    await createCoupon({ code: 'SAVE10', type: 'percent', value: 1000 });

    await applyCoupon(db, cartId, ' save10 ');

    const row = await db.first<{ coupon_code: string }>('SELECT coupon_code FROM carts WHERE id = ?', [cartId]);
    expect(row?.coupon_code).toBe('SAVE10');

    const cart = await getCart(db, cartId, settings);
    expect(cart.couponCode).toBe('SAVE10');
    expect(cart.coupon?.id).toBe('cpn_test_save10');
    expect(cart.couponError).toBeNull();
    expect(cart.pricing.discountPaise).toBe(2990);
  });

  it('survives adding and removing items', async () => {
    const cartId = await createCart();
    await createCoupon({ code: 'SAVE10', type: 'percent', value: 1000 });
    await applyCoupon(db, cartId, 'SAVE10');

    await addToCart(cartId, SMALL, 1);
    await addToCart(cartId, LARGE, 1);
    await removeItem(db, cartId, SMALL);

    const cart = await getCart(db, cartId, settings);
    expect(cart.couponCode).toBe('SAVE10');
    expect(cart.pricing.discountPaise).toBe(5490);
  });

  it('keeps an empty cart’s coupon so it starts working once items go back in', async () => {
    const cartId = await createCart();
    await applyCoupon(db, cartId, 'SAVE10');

    expect((await getCart(db, cartId, settings)).couponCode).toBe('SAVE10');
  });

  it('explains a coupon it cannot apply instead of silently dropping it', async () => {
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1); // ₹299
    await createCoupon({ code: 'BIG', type: 'fixed', value: 10_000, min_subtotal_paise: 99_900 });
    await applyCoupon(db, cartId, 'BIG');

    const cart = await getCart(db, cartId, settings);
    expect(cart.couponCode).toBe('BIG'); // still shown to the customer
    expect(cart.coupon).toBeNull(); // but not applied
    expect(cart.couponError).toBe('Add ₹700 more to use this coupon.');
    expect(cart.pricing.discountPaise).toBe(0);
  });

  it('explains a code that does not exist', async () => {
    const cartId = await createCart();
    await addToCart(cartId, SMALL, 1);
    await applyCoupon(db, cartId, 'NOPE');

    const cart = await getCart(db, cartId, settings);
    expect(cart.couponError).toBe('That coupon code is not recognised.');
  });

  it('counts a first-order coupon against the signed-in customer', async () => {
    const user = await createUser({ email: 'returning@example.com' });
    const cartId = await createCart(user.id);
    await addToCart(cartId, SMALL, 1);
    await createCoupon({ code: 'FIRST', type: 'percent', value: 1000, first_order_only: 1 });
    await applyCoupon(db, cartId, 'FIRST');

    expect((await getCart(db, cartId, settings, { userId: user.id })).coupon?.code).toBe('FIRST');

    // Once they have a paid order behind them the coupon stops applying.
    await db.run(
      `INSERT INTO orders (id, order_number, user_id, email, phone, customer_name, status, payment_status,
                           shipping_address_json, billing_address_json, placed_at, created_at, updated_at)
       VALUES ('ord_prior', 'MGS-26-0001', ?, ?, '+919845012345', 'Asha Rao', 'delivered', 'paid',
               '{}', '{}', ?, ?, ?)`,
      [user.id, user.email, 1, 1, 1],
    );

    const after = await getCart(db, cartId, settings, { userId: user.id });
    expect(after.coupon).toBeNull();
    expect(after.couponError).toBe('That coupon is for first orders only.');
  });

  it('drops the code when it is removed', async () => {
    const cartId = await createCart();
    await applyCoupon(db, cartId, 'SAVE10');
    await removeCoupon(db, cartId);

    expect((await getCart(db, cartId, settings)).couponCode).toBeNull();
  });
});

describe('merging a guest cart into a user cart', () => {
  it('sums the quantities of a variant both carts hold', async () => {
    const user = await createUser();
    const userCart = await createCart(user.id, 'crt_user');
    const guestCart = await createCart(null, 'crt_guest');

    await addToCart(userCart, SMALL, 1);
    await addToCart(guestCart, SMALL, 2);

    const merged = await mergeCarts(db, guestCart, user.id, settings);
    expect(merged).toBe(userCart);

    const cart = await getCart(db, userCart, settings);
    expect(cart.lines).toHaveLength(1);
    // Two while logged out plus one saved means three, not one.
    expect(cart.lines[0].qty).toBe(3);
  });

  it('carries over a variant the user cart did not have', async () => {
    const user = await createUser();
    const userCart = await createCart(user.id, 'crt_user');
    const guestCart = await createCart(null, 'crt_guest');

    await addToCart(userCart, SMALL, 1);
    await addToCart(guestCart, LARGE, 2);

    await mergeCarts(db, guestCart, user.id, settings);

    const cart = await getCart(db, userCart, settings);
    expect(cart.lines.map((l) => [l.variantId, l.qty])).toEqual([
      [SMALL, 1],
      [LARGE, 2],
    ]);
  });

  it('still respects the per-variant cap when summing', async () => {
    const user = await createUser();
    const userCart = await createCart(user.id, 'crt_user');
    const guestCart = await createCart(null, 'crt_guest');

    await addToCart(userCart, SMALL, 10);
    await addToCart(guestCart, SMALL, 10);

    await mergeCarts(db, guestCart, user.id, settings);
    expect((await getCart(db, userCart, settings)).lines[0].qty).toBe(12);
  });

  it('abandons the guest cart so it cannot be reused', async () => {
    const user = await createUser();
    await createCart(user.id, 'crt_user');
    const guestCart = await createCart(null, 'crt_guest');
    await addToCart(guestCart, SMALL, 1);

    await mergeCarts(db, guestCart, user.id, settings);

    const row = await db.first<{ status: string }>('SELECT status FROM carts WHERE id = ?', [guestCart]);
    expect(row?.status).toBe('abandoned');
  });

  it('carries the guest coupon over only when the user cart has none', async () => {
    const user = await createUser();
    const userCart = await createCart(user.id, 'crt_user');
    const guestCart = await createCart(null, 'crt_guest');
    await applyCoupon(db, guestCart, 'GUEST10');

    await mergeCarts(db, guestCart, user.id, settings);
    expect((await getCart(db, userCart, settings)).couponCode).toBe('GUEST10');
  });

  it('does not overwrite a coupon the user cart already had', async () => {
    const user = await createUser();
    const userCart = await createCart(user.id, 'crt_user');
    const guestCart = await createCart(null, 'crt_guest');
    await applyCoupon(db, userCart, 'MINE');
    await applyCoupon(db, guestCart, 'GUEST10');

    await mergeCarts(db, guestCart, user.id, settings);
    expect((await getCart(db, userCart, settings)).couponCode).toBe('MINE');
  });

  it('simply adopts the guest cart when the customer has none of their own', async () => {
    const user = await createUser();
    const guestCart = await createCart(null, 'crt_guest');
    await addToCart(guestCart, SMALL, 2);

    const merged = await mergeCarts(db, guestCart, user.id, settings);
    expect(merged).toBe(guestCart);

    const row = await db.first<{ user_id: string; status: string }>(
      'SELECT user_id, status FROM carts WHERE id = ?',
      [guestCart],
    );
    expect(row).toEqual({ user_id: user.id, status: 'active' });
  });

  it('is a no-op for a cart that does not exist', async () => {
    const user = await createUser();
    expect(await mergeCarts(db, 'crt_missing', user.id, settings)).toBe('crt_missing');
  });
});
