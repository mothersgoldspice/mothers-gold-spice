/**
 * Cart: server-side, cookie-identified, survives across devices once signed in.
 *
 * The cart lives in D1 rather than in localStorage so that stock checks, coupon
 * validation and pricing all run against the same numbers the order will be
 * created from — a client-side cart means the price shown and the price charged
 * are computed by two different code paths, which is how stores end up honouring
 * a stale ₹199.
 *
 * Identity: an anonymous visitor gets a random cart id in an HttpOnly cookie.
 * On sign-in the anonymous cart is merged into the user's cart and the cookie is
 * repointed. Cart ids carry 128 bits of entropy, so possessing the cookie is the
 * only way to reach a cart.
 */

import type { AstroCookies } from 'astro';
import type { AppContext } from '../context';
import type { Db } from '../db/client';
import type { CartItemRow, CartRow, CouponRow } from '../db/types';
import { badRequest, conflict } from '../errors';
import { newToken } from '../ids';
import { log } from '../log';
import { CART_COOKIE, CART_TTL_MS, setCookie } from '../auth/cookies';
import { getSellableVariants, type SellableVariant } from './catalog';
import { priceOrder, validateCoupon, type PricingResult } from './pricing';
import type { StoreSettings } from '../settings';
import type { Zone } from '../shipping-zones';

export interface CartLine {
  id: string;
  variantId: string;
  qty: number;
  /** Live catalogue price. The snapshot on the row is only a change detector. */
  unitPricePaise: number;
  snapshotPricePaise: number;
  priceChanged: boolean;
  lineTotalPaise: number;
  variant: SellableVariant;
  /** Set when stock cannot cover the requested quantity. */
  availabilityIssue: { available: number } | null;
}

export interface CartView {
  id: string;
  lines: CartLine[];
  itemCount: number;
  couponCode: string | null;
  coupon: CouponRow | null;
  couponError: string | null;
  pricing: PricingResult;
  hasIssues: boolean;
}

function newCartId(): string {
  // 128 bits — a cart id in a cookie is a bearer credential, so it must not be
  // enumerable the way a short k-sortable id would be.
  return `crt_${newToken(16)}`;
}

/** Read the cart id from context, creating a cart row on first write. */
export async function getOrCreateCart(ctx: AppContext, cookies: AstroCookies): Promise<string> {
  const existing = ctx.cartId ? await loadCartRow(ctx.db, ctx.cartId) : null;
  if (existing) {
    // Adopt an anonymous cart the moment its owner signs in.
    if (ctx.user && existing.user_id === null) {
      await ctx.db.run('UPDATE carts SET user_id = ?, updated_at = ? WHERE id = ?', [
        ctx.user.id,
        Date.now(),
        existing.id,
      ]);
    }
    return existing.id;
  }

  // A signed-in customer returning on a new device should find their cart.
  if (ctx.user) {
    const owned = await ctx.db.first<CartRow>(
      "SELECT * FROM carts WHERE user_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
      [ctx.user.id],
    );
    if (owned) {
      ctx.cartId = owned.id;
      setCookie(cookies, ctx.env, CART_COOKIE, owned.id, CART_TTL_MS);
      return owned.id;
    }
  }

  const id = newCartId();
  const now = Date.now();
  await ctx.db.run(
    `INSERT INTO carts (id, user_id, status, currency, created_at, updated_at, expires_at)
     VALUES (?, ?, 'active', 'INR', ?, ?, ?)`,
    [id, ctx.user?.id ?? null, now, now, now + CART_TTL_MS],
  );
  ctx.cartId = id;
  setCookie(cookies, ctx.env, CART_COOKIE, id, CART_TTL_MS);
  return id;
}

async function loadCartRow(db: Db, cartId: string): Promise<CartRow | null> {
  return db.first<CartRow>("SELECT * FROM carts WHERE id = ? AND status = 'active'", [cartId]);
}

/**
 * Build the full cart view.
 *
 * Prices come from the catalogue, not from `cart_items.unit_price_paise`. The
 * stored value is retained only so the UI can say "the price of this changed
 * since you added it" — silently charging the old price would be a pricing bug
 * and silently charging the new one without saying so is a trust problem.
 */
export async function getCart(
  db: Db,
  cartId: string | null,
  settings: StoreSettings,
  opts: { zone?: Zone | null; paymentMethod?: 'prepaid' | 'cod'; now?: number; userId?: string | null } = {},
): Promise<CartView> {
  const empty = (id: string): CartView => ({
    id,
    lines: [],
    itemCount: 0,
    couponCode: null,
    coupon: null,
    couponError: null,
    pricing: priceOrder({
      lines: [],
      settings,
      zone: opts.zone ?? null,
      paymentMethod: opts.paymentMethod ?? 'prepaid',
      coupon: null,
      shippingUnknown: opts.zone == null,
    }),
    hasIssues: false,
  });

  if (!cartId) return empty('');
  const cart = await loadCartRow(db, cartId);
  if (!cart) return empty(cartId);

  const items = await db.all<CartItemRow>('SELECT * FROM cart_items WHERE cart_id = ? ORDER BY created_at', [cartId]);
  if (items.length === 0) return { ...empty(cartId), couponCode: cart.coupon_code ?? null };

  const variants = await getSellableVariants(
    db,
    items.map((i) => i.variant_id),
  );

  const lines: CartLine[] = [];
  for (const item of items) {
    const variant = variants.get(item.variant_id);
    // A variant that was archived out of the catalogue drops out of the cart
    // rather than blocking checkout with an unpurchasable line.
    if (!variant || variant.productStatus !== 'active') continue;

    const available = variant.available;
    lines.push({
      id: item.id,
      variantId: item.variant_id,
      qty: item.qty,
      unitPricePaise: variant.pricePaise,
      snapshotPricePaise: item.unit_price_paise,
      priceChanged: variant.pricePaise !== item.unit_price_paise,
      lineTotalPaise: variant.pricePaise * item.qty,
      variant,
      availabilityIssue: available < item.qty ? { available: Number.isFinite(available) ? available : 0 } : null,
    });
  }

  // ── Coupon ────────────────────────────────────────────────────────────────
  const now = opts.now ?? Date.now();
  const subtotal = lines.reduce((sum, l) => sum + l.lineTotalPaise, 0);
  let coupon: CouponRow | null = null;
  let couponError: string | null = null;

  if (cart.coupon_code) {
    coupon = await findCoupon(db, cart.coupon_code);
    const verdict = validateCoupon(coupon, {
      subtotalPaise: subtotal,
      userRedemptions: coupon ? await countRedemptions(db, coupon.id, opts.userId ?? null, null) : 0,
      hasPriorOrders: opts.userId ? await hasPaidOrder(db, opts.userId) : false,
      now,
    });
    if (!verdict.valid) {
      // Keep showing the code with an explanation rather than dropping it
      // silently — a customer who added ₹40 of items expects it to start working.
      couponError = verdict.message ?? 'That coupon cannot be applied.';
      coupon = null;
    }
  }

  const pricing = priceOrder({
    lines: lines.map((l) => ({
      variantId: l.variantId,
      qty: l.qty,
      unitPricePaise: l.unitPricePaise,
      gstRateBps: l.variant.gstRateBps,
      shippingWeightGrams: l.variant.shippingWeightGrams,
    })),
    settings,
    zone: opts.zone ?? null,
    paymentMethod: opts.paymentMethod ?? 'prepaid',
    coupon,
    shippingUnknown: opts.zone == null,
  });

  return {
    id: cartId,
    lines,
    itemCount: lines.reduce((sum, l) => sum + l.qty, 0),
    couponCode: cart.coupon_code ?? null,
    coupon,
    couponError,
    pricing,
    hasIssues: lines.some((l) => l.availabilityIssue !== null || l.priceChanged),
  };
}

export async function addItem(
  db: Db,
  cartId: string,
  variantId: string,
  qty: number,
  settings: StoreSettings,
): Promise<void> {
  const variant = (await getSellableVariants(db, [variantId])).get(variantId);
  if (!variant || variant.productStatus !== 'active') {
    throw badRequest('That item is no longer available.');
  }

  const existing = await db.first<CartItemRow>('SELECT * FROM cart_items WHERE cart_id = ? AND variant_id = ?', [
    cartId,
    variantId,
  ]);
  const nextQty = Math.min((existing?.qty ?? 0) + qty, settings.maxQtyPerVariant);

  if (nextQty <= (existing?.qty ?? 0) && existing) {
    throw conflict(`You can order up to ${settings.maxQtyPerVariant} of one jar size per order.`);
  }
  if (Number.isFinite(variant.available) && variant.available < nextQty) {
    throw conflict(
      variant.available <= 0
        ? 'That size just sold out.'
        : `Only ${variant.available} left of that size.`,
    );
  }

  await assertOrderLimits(db, cartId, settings, existing ? 0 : 1);

  const now = Date.now();
  if (existing) {
    await db.run('UPDATE cart_items SET qty = ?, unit_price_paise = ?, updated_at = ? WHERE id = ?', [
      nextQty,
      variant.pricePaise,
      now,
      existing.id,
    ]);
  } else {
    await db.run(
      `INSERT INTO cart_items (id, cart_id, variant_id, qty, unit_price_paise, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`itm_${newToken(10)}`, cartId, variantId, nextQty, variant.pricePaise, now, now],
    );
  }
  await touchCart(db, cartId, now);
  log.info('cart.item_added', { cartId, variantId, qty: nextQty });
}

/** Set an exact quantity; 0 removes the line. */
export async function updateItem(
  db: Db,
  cartId: string,
  variantId: string,
  qty: number,
  settings: StoreSettings,
): Promise<void> {
  if (qty <= 0) return removeItem(db, cartId, variantId);

  const capped = Math.min(qty, settings.maxQtyPerVariant);
  const variant = (await getSellableVariants(db, [variantId])).get(variantId);
  if (!variant) throw badRequest('That item is no longer available.');
  if (Number.isFinite(variant.available) && variant.available < capped) {
    throw conflict(variant.available <= 0 ? 'That size just sold out.' : `Only ${variant.available} left of that size.`);
  }

  const now = Date.now();
  const changed = await db.run(
    'UPDATE cart_items SET qty = ?, unit_price_paise = ?, updated_at = ? WHERE cart_id = ? AND variant_id = ?',
    [capped, variant.pricePaise, now, cartId, variantId],
  );
  if (changed === 0) throw badRequest('That item is not in your cart.');
  await touchCart(db, cartId, now);
}

export async function removeItem(db: Db, cartId: string, variantId: string): Promise<void> {
  await db.run('DELETE FROM cart_items WHERE cart_id = ? AND variant_id = ?', [cartId, variantId]);
  await touchCart(db, cartId, Date.now());
}

export async function clearCart(db: Db, cartId: string): Promise<void> {
  await db.batch([
    db.stmt('DELETE FROM cart_items WHERE cart_id = ?', [cartId]),
    db.stmt('UPDATE carts SET coupon_code = NULL, updated_at = ? WHERE id = ?', [Date.now(), cartId]),
  ]);
}

/** Attach a coupon code to the cart. Validation happens on every read. */
export async function applyCoupon(db: Db, cartId: string, code: string): Promise<void> {
  await db.run('UPDATE carts SET coupon_code = ?, updated_at = ? WHERE id = ?', [
    code.trim().toUpperCase(),
    Date.now(),
    cartId,
  ]);
}

export async function removeCoupon(db: Db, cartId: string): Promise<void> {
  await db.run('UPDATE carts SET coupon_code = NULL, updated_at = ? WHERE id = ?', [Date.now(), cartId]);
}

/**
 * Fold an anonymous cart into the signed-in customer's cart.
 *
 * Quantities are summed and capped rather than overwritten: a customer who added
 * a jar while logged out and already had one saved expects two, not one.
 */
export async function mergeCarts(
  db: Db,
  guestCartId: string,
  userId: string,
  settings: StoreSettings,
): Promise<string> {
  const guest = await loadCartRow(db, guestCartId);
  if (!guest) return guestCartId;

  const target = await db.first<CartRow>(
    "SELECT * FROM carts WHERE user_id = ? AND status = 'active' AND id <> ? ORDER BY updated_at DESC LIMIT 1",
    [userId, guestCartId],
  );

  if (!target) {
    await db.run('UPDATE carts SET user_id = ?, updated_at = ? WHERE id = ?', [userId, Date.now(), guestCartId]);
    return guestCartId;
  }

  const guestItems = await db.all<CartItemRow>('SELECT * FROM cart_items WHERE cart_id = ?', [guestCartId]);
  const targetItems = await db.all<CartItemRow>('SELECT * FROM cart_items WHERE cart_id = ?', [target.id]);
  const targetByVariant = new Map(targetItems.map((i) => [i.variant_id, i]));

  const now = Date.now();
  const statements = guestItems.map((item) => {
    const existing = targetByVariant.get(item.variant_id);
    if (existing) {
      const qty = Math.min(existing.qty + item.qty, settings.maxQtyPerVariant);
      return db.stmt('UPDATE cart_items SET qty = ?, updated_at = ? WHERE id = ?', [qty, now, existing.id]);
    }
    return db.stmt(
      `INSERT INTO cart_items (id, cart_id, variant_id, qty, unit_price_paise, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`itm_${newToken(10)}`, target.id, item.variant_id, item.qty, item.unit_price_paise, now, now],
    );
  });

  statements.push(
    // A coupon the guest entered carries over only if the target has none.
    db.stmt('UPDATE carts SET coupon_code = COALESCE(coupon_code, ?), updated_at = ? WHERE id = ?', [
      guest.coupon_code,
      now,
      target.id,
    ]),
    db.stmt("UPDATE carts SET status = 'abandoned', updated_at = ? WHERE id = ?", [now, guestCartId]),
  );

  await db.batch(statements);
  log.info('cart.merged', { from: guestCartId, into: target.id, userId, lines: guestItems.length });
  return target.id;
}

/** Mark a cart converted once its order exists, so it stops being reused. */
export async function markCartConverted(db: Db, cartId: string, orderId: string): Promise<void> {
  await db.run("UPDATE carts SET status = 'converted', order_id = ?, updated_at = ? WHERE id = ?", [
    orderId,
    Date.now(),
    cartId,
  ]);
}

export async function findCoupon(db: Db, code: string): Promise<CouponRow | null> {
  return db.first<CouponRow>('SELECT * FROM coupons WHERE code = ?', [code.trim().toUpperCase()]);
}

/**
 * How many times this identity has redeemed a coupon.
 *
 * Guests are counted by email because they have no user id — otherwise a
 * first-order-only coupon would be reusable forever by simply not signing up.
 */
export async function countRedemptions(
  db: Db,
  couponId: string,
  userId: string | null,
  email: string | null,
): Promise<number> {
  if (!userId && !email) return 0;
  const count = await db.scalar<number>(
    userId
      ? 'SELECT COUNT(*) FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ?'
      : 'SELECT COUNT(*) FROM coupon_redemptions WHERE coupon_id = ? AND email = ?',
    [couponId, userId ?? (email as string)],
  );
  return count ?? 0;
}

export async function hasPaidOrder(db: Db, userId: string): Promise<boolean> {
  const count = await db.scalar<number>(
    "SELECT COUNT(*) FROM orders WHERE user_id = ? AND payment_status IN ('paid','partially_refunded','refunded')",
    [userId],
  );
  return (count ?? 0) > 0;
}

async function touchCart(db: Db, cartId: string, now: number): Promise<void> {
  await db.run('UPDATE carts SET updated_at = ?, expires_at = ? WHERE id = ?', [now, now + CART_TTL_MS, cartId]);
}

async function assertOrderLimits(
  db: Db,
  cartId: string,
  settings: StoreSettings,
  additionalLines: number,
): Promise<void> {
  const totals = await db.first<{ lines: number; units: number }>(
    'SELECT COUNT(*) AS lines, COALESCE(SUM(qty), 0) AS units FROM cart_items WHERE cart_id = ?',
    [cartId],
  );
  const units = totals?.units ?? 0;
  if (units >= settings.maxItemsPerOrder) {
    throw conflict(
      `A single order can hold up to ${settings.maxItemsPerOrder} jars. For a bulk order, please write to us — we will sort it out directly.`,
    );
  }
  if ((totals?.lines ?? 0) + additionalLines > 30) {
    throw conflict('That is too many different items in one cart.');
  }
}

/** Sweep carts nobody has touched in a month. Called by the maintenance route. */
export async function pruneExpiredCarts(db: Db): Promise<number> {
  return db.run("UPDATE carts SET status = 'abandoned' WHERE status = 'active' AND expires_at < ?", [Date.now()]);
}

export function cartCookieName(): string {
  return CART_COOKIE;
}
