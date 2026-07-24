/**
 * Orders: creation, the status state machine, the event timeline, and access.
 *
 * An order is a SNAPSHOT. Product names, variant names, prices, tax rates and
 * both addresses are copied onto `orders`/`order_items` at placement, so editing
 * the catalogue tomorrow cannot rewrite what a customer bought today — which is
 * both an accounting requirement and the reason an invoice can be regenerated
 * years later.
 *
 * Placement reserves stock but does NOT decrement it. Stock leaves the shelf
 * only when payment is confirmed (or, for COD, at the moment the order is
 * confirmed), and a reservation that is never paid for expires and is released.
 */

import type { AppContext } from '../context';
import type { Db } from '../db/client';
import { parseJson } from '../db/client';
import type {
  AddressSnapshot,
  CouponRow,
  OrderEventRow,
  OrderItemRow,
  OrderRow,
  OrderStatus,
  PaymentMethod,
} from '../db/types';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { hmacSha256Hex, sha256Hex } from '../crypto';
import { sessionSecret, type Env } from '../env';
import { formatOrderNumber, newId, newToken } from '../ids';
import { log, maskEmail } from '../log';
import type { StoreSettings } from '../settings';
import { zoneForPincode, type Zone } from '../shipping-zones';
import type { CartView } from './cart';
import { countRedemptions, findCoupon, hasPaidOrder, markCartConverted } from './cart';
import { commitReservation, releaseReservation, reserveStock, type StockLine } from './inventory';
import { priceOrder, validateCoupon } from './pricing';

// ─── Status machine ──────────────────────────────────────────────────────────

/**
 * Legal transitions. Anything not listed is refused, which is what stops a
 * webhook arriving out of order from moving a delivered parcel back to
 * "processing" or a cancelled order forward to "shipped".
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ['confirmed', 'payment_failed', 'cancelled'],
  // A failed payment is retryable — the customer may pay on a second attempt.
  payment_failed: ['pending_payment', 'confirmed', 'cancelled'],
  confirmed: ['processing', 'packed', 'cancelled', 'refunded'],
  processing: ['packed', 'shipped', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['out_for_delivery', 'delivered', 'returned'],
  out_for_delivery: ['delivered', 'shipped', 'returned'],
  delivered: ['returned', 'refunded'],
  cancelled: ['refunded'],
  returned: ['refunded'],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Customer-facing wording for each status. */
export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: 'Awaiting payment',
  payment_failed: 'Payment failed',
  confirmed: 'Confirmed',
  processing: 'Being packed',
  packed: 'Packed',
  shipped: 'Shipped',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  returned: 'Returned',
  refunded: 'Refunded',
};

/** Statuses the customer may still cancel from without contacting us. */
const CUSTOMER_CANCELLABLE: OrderStatus[] = ['pending_payment', 'payment_failed', 'confirmed', 'processing'];

export function isCustomerCancellable(status: OrderStatus): boolean {
  return CUSTOMER_CANCELLABLE.includes(status);
}

// ─── Views ───────────────────────────────────────────────────────────────────

export interface OrderView {
  order: OrderRow;
  items: OrderItemRow[];
  events: OrderEventRow[];
  shippingAddress: AddressSnapshot;
  billingAddress: AddressSnapshot;
}

export async function getOrderById(db: Db, orderId: string): Promise<OrderRow | null> {
  return db.first<OrderRow>('SELECT * FROM orders WHERE id = ?', [orderId]);
}

export async function getOrderByNumber(db: Db, orderNumber: string): Promise<OrderRow | null> {
  return db.first<OrderRow>('SELECT * FROM orders WHERE order_number = ?', [orderNumber.trim().toUpperCase()]);
}

export async function loadOrderView(db: Db, orderId: string, opts: { adminView?: boolean } = {}): Promise<OrderView> {
  const order = await getOrderById(db, orderId);
  if (!order) throw notFound('We could not find that order.');

  const items = await db.all<OrderItemRow>('SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at', [
    orderId,
  ]);
  const events = await db.all<OrderEventRow>(
    opts.adminView
      ? 'SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at DESC'
      : 'SELECT * FROM order_events WHERE order_id = ? AND is_customer_visible = 1 ORDER BY created_at DESC',
    [orderId],
  );

  return {
    order,
    items,
    events,
    shippingAddress: parseJson<AddressSnapshot>(order.shipping_address_json, emptyAddress()),
    billingAddress: parseJson<AddressSnapshot>(order.billing_address_json, emptyAddress()),
  };
}

function emptyAddress(): AddressSnapshot {
  return { full_name: '', phone: '', line1: '', city: '', state: '', pincode: '', country: 'IN' };
}

export interface OrderListItem {
  order: OrderRow;
  itemCount: number;
  firstItemName: string;
  firstItemImage: string | null;
}

export async function listOrdersForUser(db: Db, userId: string, limit = 50, offset = 0): Promise<OrderListItem[]> {
  const orders = await db.all<OrderRow>(
    'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [userId, Math.min(limit, 100), offset],
  );
  return attachSummaries(db, orders);
}

/** Admin list with filters. */
export async function listOrders(
  db: Db,
  filters: { status?: OrderStatus | null; search?: string | null; limit?: number; offset?: number } = {},
): Promise<{ items: OrderListItem[]; total: number }> {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filters.status) {
    where.push('status = ?');
    params.push(filters.status);
  }
  if (filters.search) {
    const term = `%${filters.search.trim().toLowerCase()}%`;
    where.push('(LOWER(order_number) LIKE ? OR LOWER(email) LIKE ? OR LOWER(customer_name) LIKE ? OR phone LIKE ?)');
    params.push(term, term, term, term);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.scalar<number>(`SELECT COUNT(*) FROM orders ${clause}`, params)) ?? 0;

  const limit = Math.min(filters.limit ?? 50, 200);
  const orders = await db.all<OrderRow>(
    `SELECT * FROM orders ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, filters.offset ?? 0],
  );

  return { items: await attachSummaries(db, orders), total };
}

async function attachSummaries(db: Db, orders: OrderRow[]): Promise<OrderListItem[]> {
  if (orders.length === 0) return [];
  const ids = orders.map((o) => o.id);
  const items = await db.all<OrderItemRow>(
    `SELECT * FROM order_items WHERE order_id IN (${ids.map(() => '?').join(', ')}) ORDER BY created_at`,
    ids,
  );

  const byOrder = new Map<string, OrderItemRow[]>();
  for (const item of items) {
    const list = byOrder.get(item.order_id) ?? [];
    list.push(item);
    byOrder.set(item.order_id, list);
  }

  return orders.map((order) => {
    const list = byOrder.get(order.id) ?? [];
    return {
      order,
      itemCount: list.reduce((sum, i) => sum + i.qty, 0),
      firstItemName: list[0] ? `${list[0].product_name} ${list[0].variant_name}` : '',
      firstItemImage: list[0]?.image ?? null,
    };
  });
}

// ─── Access control ──────────────────────────────────────────────────────────

/**
 * The token in a guest's tracking link.
 *
 * DERIVED from the order id rather than randomly generated, because a guest who
 * pays online is emailed their receipt by the payment webhook — minutes after
 * checkout, in a different request, where a one-shot random token generated at
 * placement is no longer in hand. Deriving it means any later code path can
 * rebuild the same link.
 *
 * It is an HMAC under SESSION_SECRET, so it is unguessable without the secret;
 * only its SHA-256 is stored on the order, so a database leak does not hand out
 * every customer's address.
 */
export async function guestAccessToken(env: Env, orderId: string): Promise<string> {
  return hmacSha256Hex(sessionSecret(env), `order-access:v1:${orderId}`);
}

/**
 * Decide whether the caller may see an order.
 *
 * Guests get the derived token in their confirmation email rather than a bare
 * URL — order ids are k-sortable, so `/track/ord_01k…` would otherwise be
 * walkable to the previous customer's address and phone number.
 */
export async function assertOrderAccess(
  ctx: AppContext,
  order: OrderRow,
  guestToken?: string | null,
): Promise<void> {
  if (ctx.isAdmin) return;
  if (ctx.user && order.user_id === ctx.user.id) return;

  if (guestToken && order.guest_token_hash) {
    const presented = await sha256Hex(guestToken);
    if (presented === order.guest_token_hash) return;
  }

  log.warn('orders.access_denied', { orderId: order.id, userId: ctx.user?.id ?? null });
  throw forbidden('You do not have access to that order.');
}

// ─── Events ──────────────────────────────────────────────────────────────────

export interface OrderEventInput {
  orderId: string;
  type: string;
  message: string;
  data?: Record<string, unknown>;
  actorType?: OrderEventRow['actor_type'];
  actorId?: string | null;
  customerVisible?: boolean;
}

export function orderEventStatement(db: Db, input: OrderEventInput) {
  return db.stmt(
    `INSERT INTO order_events (id, order_id, type, message, data_json, actor_type, actor_id,
                               is_customer_visible, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('evt'),
      input.orderId,
      input.type,
      input.message,
      JSON.stringify(input.data ?? {}),
      input.actorType ?? 'system',
      input.actorId ?? null,
      input.customerVisible === false ? 0 : 1,
      Date.now(),
    ],
  );
}

export async function recordOrderEvent(db: Db, input: OrderEventInput): Promise<void> {
  await db.batch([orderEventStatement(db, input)]);
}

// ─── Creation ────────────────────────────────────────────────────────────────

export interface CreateOrderInput {
  cart: CartView;
  settings: StoreSettings;
  email: string;
  customerName: string;
  phone: string;
  shippingAddress: AddressSnapshot;
  billingAddress: AddressSnapshot;
  paymentMethod: PaymentMethod;
  shippingMethod: string;
  customerNote?: string | null;
  userId: string | null;
  isGuest: boolean;
  idempotencyKey?: string | null;
}

export interface CreateOrderResult {
  order: OrderRow;
  items: OrderItemRow[];
  /** Raw guest access token — emailed, never stored. */
  guestToken: string;
  /** True when an existing order was returned for a repeated idempotency key. */
  reused: boolean;
}

/**
 * Turn a cart into an order.
 *
 * Prices are recomputed here from the catalogue rather than trusted from the
 * cart view the browser last saw — the only number the client gets to influence
 * is quantity.
 */
export async function createOrder(ctx: AppContext, input: CreateOrderInput): Promise<CreateOrderResult> {
  const { cart, settings } = input;

  if (!settings.storeOpen) throw conflict(settings.storeClosedMessage);
  if (cart.lines.length === 0) throw badRequest('Your cart is empty.');

  // A double-submitted checkout (impatient tap, browser retry) must produce one
  // order, so a repeated key returns the order that already exists.
  if (input.idempotencyKey) {
    const existing = await ctx.db.first<OrderRow>('SELECT * FROM orders WHERE idempotency_key = ?', [
      input.idempotencyKey,
    ]);
    if (existing) {
      log.info('orders.idempotent_replay', { orderId: existing.id, key: input.idempotencyKey });
      const items = await ctx.db.all<OrderItemRow>('SELECT * FROM order_items WHERE order_id = ?', [existing.id]);
      return { order: existing, items, guestToken: '', reused: true };
    }
  }

  const zone: Zone = zoneForPincode(input.shippingAddress.pincode);

  // ── Re-validate the coupon against the real basket ──────────────────────
  let coupon: CouponRow | null = null;
  if (cart.couponCode) {
    const candidate = await findCoupon(ctx.db, cart.couponCode);
    const subtotal = cart.lines.reduce((sum, l) => sum + l.unitPricePaise * l.qty, 0);
    const verdict = validateCoupon(candidate, {
      subtotalPaise: subtotal,
      userRedemptions: candidate
        ? await countRedemptions(ctx.db, candidate.id, input.userId, input.email.toLowerCase())
        : 0,
      hasPriorOrders: input.userId ? await hasPaidOrder(ctx.db, input.userId) : false,
      now: Date.now(),
    });
    if (verdict.valid) coupon = candidate;
    else if (candidate) {
      // Refuse rather than silently charging more than the cart page promised.
      throw conflict(verdict.message ?? 'That coupon can no longer be applied.');
    }
  }

  const pricing = priceOrder({
    lines: cart.lines.map((l) => ({
      variantId: l.variantId,
      qty: l.qty,
      unitPricePaise: l.unitPricePaise,
      gstRateBps: l.variant.gstRateBps,
      shippingWeightGrams: l.variant.shippingWeightGrams,
    })),
    settings,
    zone,
    paymentMethod: input.paymentMethod,
    coupon,
  });

  if (pricing.totalPaise <= 0) throw badRequest('That order total is not valid. Please review your cart.');

  if (input.paymentMethod === 'cod') {
    if (!settings.codEnabled) throw conflict('Cash on delivery is not available right now.');
    if (pricing.totalPaise < settings.codMinOrderPaise) {
      throw conflict(`Cash on delivery needs an order of at least ₹${Math.ceil(settings.codMinOrderPaise / 100)}.`);
    }
    if (pricing.totalPaise > settings.codMaxOrderPaise) {
      throw conflict(`Cash on delivery is available up to ₹${Math.floor(settings.codMaxOrderPaise / 100)}.`);
    }
  }

  // ── Reserve stock BEFORE writing the order ──────────────────────────────
  // If this throws, no order row exists and there is nothing to clean up.
  const stockLines: StockLine[] = cart.lines.map((l) => ({ variantId: l.variantId, qty: l.qty }));
  await reserveStock(ctx.db, stockLines, 'pending');

  const now = Date.now();
  const orderId = newId('ord');
  const guestToken = await guestAccessToken(ctx.env, orderId);
  const guestTokenHash = await sha256Hex(guestToken);
  const reservedUntil = now + settings.reservationMinutes * 60 * 1000;

  try {
    const orderNumber = await allocateOrderNumber(ctx.db, now);

    const itemRows: OrderItemRow[] = pricing.lines.map((priced) => {
      const line = cart.lines.find((l) => l.variantId === priced.variantId);
      if (!line) throw badRequest('Your cart changed while checking out. Please review it and try again.');
      return {
        id: newId('oit'),
        order_id: orderId,
        variant_id: line.variantId,
        product_id: line.variant.productId,
        sku: line.variant.sku,
        product_name: line.variant.productName,
        variant_name: line.variant.name,
        image: line.variant.productImage,
        unit_price_paise: priced.unitPricePaise,
        qty: priced.qty,
        subtotal_paise: priced.subtotalPaise,
        discount_paise: priced.discountPaise,
        tax_paise: priced.taxPaise,
        tax_rate_bps: priced.gstRateBps,
        hsn_code: line.variant.hsnCode,
        weight_grams: line.variant.weightGrams,
        total_paise: priced.totalPaise,
        created_at: now,
      };
    });

    const statements = [
      ctx.db.stmt(
        `INSERT INTO orders (
           id, order_number, user_id, email, phone, customer_name, is_guest,
           status, payment_status, fulfillment_status, currency,
           subtotal_paise, discount_paise, shipping_paise, cod_fee_paise, tax_paise, total_paise,
           refunded_paise, tax_inclusive, coupon_id, coupon_code, payment_method, shipping_method,
           shipping_zone, total_weight_grams, shipping_address_json, billing_address_json,
           customer_note, guest_token_hash, idempotency_key, cart_id,
           placed_at, reserved_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_payment', 'pending', 'unfulfilled', 'INR',
                 ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          orderNumber,
          input.userId,
          input.email.trim().toLowerCase(),
          input.phone,
          input.customerName,
          input.isGuest ? 1 : 0,
          pricing.subtotalPaise,
          pricing.discountPaise,
          pricing.shippingPaise,
          pricing.codFeePaise,
          pricing.taxPaise,
          pricing.totalPaise,
          settings.taxInclusive ? 1 : 0,
          coupon?.id ?? null,
          coupon?.code ?? null,
          input.paymentMethod,
          input.shippingMethod,
          zone,
          pricing.weightGrams,
          JSON.stringify(input.shippingAddress),
          JSON.stringify(input.billingAddress),
          input.customerNote ?? null,
          guestTokenHash,
          input.idempotencyKey ?? null,
          cart.id || null,
          now,
          reservedUntil,
          now,
          now,
        ],
      ),
      ...itemRows.map((item) =>
        ctx.db.stmt(
          `INSERT INTO order_items (id, order_id, variant_id, product_id, sku, product_name, variant_name,
                                    image, unit_price_paise, qty, subtotal_paise, discount_paise, tax_paise,
                                    tax_rate_bps, hsn_code, weight_grams, total_paise, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item.id,
            item.order_id,
            item.variant_id,
            item.product_id,
            item.sku,
            item.product_name,
            item.variant_name,
            item.image,
            item.unit_price_paise,
            item.qty,
            item.subtotal_paise,
            item.discount_paise,
            item.tax_paise,
            item.tax_rate_bps,
            item.hsn_code,
            item.weight_grams,
            item.total_paise,
            item.created_at,
          ],
        ),
      ),
      orderEventStatement(ctx.db, {
        orderId,
        type: 'order.placed',
        message: `Order ${orderNumber} placed.`,
        data: { totalPaise: pricing.totalPaise, paymentMethod: input.paymentMethod },
        actorType: input.userId ? 'customer' : 'system',
        actorId: input.userId,
      }),
    ];

    if (coupon) {
      statements.push(
        ctx.db.stmt(
          `INSERT INTO coupon_redemptions (id, coupon_id, order_id, user_id, email, amount_paise, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            newId('red'),
            coupon.id,
            orderId,
            input.userId,
            input.email.trim().toLowerCase(),
            pricing.discountPaise,
            now,
          ],
        ),
        ctx.db.stmt('UPDATE coupons SET used_count = used_count + 1, updated_at = ? WHERE id = ?', [now, coupon.id]),
      );
    }

    await ctx.db.batch(statements);

    if (cart.id) await markCartConverted(ctx.db, cart.id, orderId);

    const order = (await getOrderById(ctx.db, orderId)) as OrderRow;
    log.info('orders.created', {
      orderId,
      orderNumber,
      totalPaise: pricing.totalPaise,
      email: maskEmail(input.email),
      paymentMethod: input.paymentMethod,
    });

    return { order, items: itemRows, guestToken, reused: false };
  } catch (err) {
    // The order failed to write but stock is held. Release it rather than
    // leaking a reservation that only the 30-minute sweeper would recover.
    await releaseReservation(ctx.db, stockLines, orderId).catch(() => {});
    throw err;
  }
}

/**
 * Next order number for the year.
 *
 * A COUNT-based sequence can collide under concurrency, so the caller inserts
 * inside a UNIQUE constraint and this retries with a fresh count. At this
 * store's volume that loop effectively never runs twice.
 */
async function allocateOrderNumber(db: Db, now: number): Promise<string> {
  const yearStart = Date.UTC(new Date(now).getUTCFullYear(), 0, 1);
  for (let attempt = 0; attempt < 5; attempt++) {
    const count = (await db.scalar<number>('SELECT COUNT(*) FROM orders WHERE created_at >= ?', [yearStart])) ?? 0;
    const candidate = formatOrderNumber(count + 1 + attempt, new Date(now));
    const clash = await db.first<{ id: string }>('SELECT id FROM orders WHERE order_number = ?', [candidate]);
    if (!clash) return candidate;
  }
  // Last resort: a suffix that cannot collide, rather than failing the checkout.
  return `${formatOrderNumber(Date.now() % 10000, new Date(now))}-${newToken(2)}`;
}

// ─── Transitions ─────────────────────────────────────────────────────────────

export interface TransitionInput {
  orderId: string;
  to: OrderStatus;
  message?: string;
  data?: Record<string, unknown>;
  actorType?: OrderEventRow['actor_type'];
  actorId?: string | null;
  customerVisible?: boolean;
}

/**
 * Move an order to a new status, writing the timestamp columns and the timeline
 * event in the same batch as the status change.
 */
export async function transitionOrder(db: Db, input: TransitionInput): Promise<OrderRow> {
  const order = await getOrderById(db, input.orderId);
  if (!order) throw notFound('We could not find that order.');

  if (order.status === input.to) return order;
  if (!canTransition(order.status, input.to)) {
    throw conflict(`An order that is ${STATUS_LABEL[order.status].toLowerCase()} cannot become ${STATUS_LABEL[input.to].toLowerCase()}.`);
  }

  const now = Date.now();
  const sets = ['status = ?', 'updated_at = ?'];
  const params: (string | number | null)[] = [input.to, now];

  const stamp = (column: string) => {
    sets.push(`${column} = COALESCE(${column}, ?)`);
    params.push(now);
  };
  if (input.to === 'shipped') stamp('shipped_at');
  if (input.to === 'delivered') {
    stamp('delivered_at');
    sets.push("fulfillment_status = 'fulfilled'");
  }
  if (input.to === 'cancelled') stamp('cancelled_at');
  if (input.to === 'processing' || input.to === 'packed') sets.push("fulfillment_status = 'processing'");
  if (input.to === 'returned') sets.push("fulfillment_status = 'returned'");

  params.push(input.orderId, order.status);

  await db.batch([
    // The `AND status = ?` guard makes the write a compare-and-swap, so two
    // webhooks racing to advance the same order cannot both win.
    db.stmt(`UPDATE orders SET ${sets.join(', ')} WHERE id = ? AND status = ?`, params),
    orderEventStatement(db, {
      orderId: input.orderId,
      type: `order.${input.to}`,
      message: input.message ?? `Order marked ${STATUS_LABEL[input.to].toLowerCase()}.`,
      data: input.data,
      actorType: input.actorType,
      actorId: input.actorId,
      customerVisible: input.customerVisible,
    }),
  ]);

  log.info('orders.transitioned', { orderId: input.orderId, from: order.status, to: input.to });
  return (await getOrderById(db, input.orderId)) as OrderRow;
}

export async function orderStockLines(db: Db, orderId: string): Promise<StockLine[]> {
  const items = await db.all<{ variant_id: string; qty: number }>(
    'SELECT variant_id, qty FROM order_items WHERE order_id = ?',
    [orderId],
  );
  return items.map((i) => ({ variantId: i.variant_id, qty: i.qty }));
}

/**
 * Confirm an order: stock becomes sold, the reservation hold is cleared.
 *
 * Idempotent — a replayed payment webhook finds the order already confirmed and
 * returns without decrementing stock a second time.
 */
export async function confirmOrder(
  db: Db,
  orderId: string,
  opts: { paymentStatus?: 'paid' | 'pending'; message?: string; actorId?: string | null } = {},
): Promise<{ order: OrderRow; alreadyConfirmed: boolean }> {
  const order = await getOrderById(db, orderId);
  if (!order) throw notFound('We could not find that order.');

  if (order.status !== 'pending_payment' && order.status !== 'payment_failed') {
    return { order, alreadyConfirmed: true };
  }

  const lines = await orderStockLines(db, orderId);
  await commitReservation(db, lines, orderId);

  const now = Date.now();
  const paymentStatus = opts.paymentStatus ?? 'paid';

  await db.batch([
    db.stmt(
      `UPDATE orders SET status = 'confirmed', payment_status = ?, paid_at = COALESCE(paid_at, ?),
              reserved_until = NULL, updated_at = ?
        WHERE id = ? AND status IN ('pending_payment','payment_failed')`,
      [paymentStatus, paymentStatus === 'paid' ? now : null, now, orderId],
    ),
    orderEventStatement(db, {
      orderId,
      type: 'order.confirmed',
      message: opts.message ?? 'Payment received. Your order is confirmed.',
      actorType: 'system',
      actorId: opts.actorId ?? null,
    }),
  ]);

  log.info('orders.confirmed', { orderId, paymentStatus });
  return { order: (await getOrderById(db, orderId)) as OrderRow, alreadyConfirmed: false };
}

/** Cancel an order, releasing whichever stock state it is in. */
export async function cancelOrder(
  db: Db,
  orderId: string,
  reason: string,
  actor: { type: OrderEventRow['actor_type']; id: string | null },
): Promise<OrderRow> {
  const order = await getOrderById(db, orderId);
  if (!order) throw notFound('We could not find that order.');
  if (order.status === 'cancelled') return order;
  if (!canTransition(order.status, 'cancelled')) {
    throw conflict('That order has already shipped and can no longer be cancelled here. Please write to us.');
  }

  const lines = await orderStockLines(db, orderId);
  if (order.status === 'pending_payment' || order.status === 'payment_failed') {
    // Never paid: the units were only held, so hand them straight back.
    await releaseReservation(db, lines, orderId);
  } else {
    // Already sold: put the units back on the shelf with a ledger trail.
    const now = Date.now();
    await db.batch(
      lines.flatMap((line) => [
        db.stmt('UPDATE inventory SET on_hand = on_hand + ?, updated_at = ? WHERE variant_id = ?', [
          line.qty,
          now,
          line.variantId,
        ]),
        db.stmt(
          `INSERT INTO inventory_ledger (id, variant_id, delta, reason, ref_type, ref_id, note, actor_id, created_at)
           VALUES (?, ?, ?, 'cancel', 'order', ?, ?, ?, ?)`,
          [newId('inv'), line.variantId, line.qty, orderId, reason.slice(0, 200), actor.id ?? 'system', now],
        ),
      ]),
    );
  }

  const now = Date.now();
  await db.batch([
    db.stmt(
      `UPDATE orders SET status = 'cancelled', cancel_reason = ?, cancelled_at = COALESCE(cancelled_at, ?),
              reserved_until = NULL, updated_at = ? WHERE id = ? AND status <> 'cancelled'`,
      [reason.slice(0, 300), now, now, orderId],
    ),
    orderEventStatement(db, {
      orderId,
      type: 'order.cancelled',
      message: `Order cancelled. ${reason}`.trim(),
      actorType: actor.type,
      actorId: actor.id,
    }),
  ]);

  log.info('orders.cancelled', { orderId, reason, actorType: actor.type });
  return (await getOrderById(db, orderId)) as OrderRow;
}

/**
 * Release stock held by orders that were never paid for.
 *
 * Without this every abandoned checkout would permanently shrink availability —
 * the shop would show "sold out" while jars sat on the shelf.
 */
export async function expireStaleReservations(db: Db, limit = 50): Promise<number> {
  const now = Date.now();
  const stale = await db.all<OrderRow>(
    `SELECT * FROM orders WHERE status = 'pending_payment' AND reserved_until IS NOT NULL AND reserved_until < ?
      ORDER BY reserved_until ASC LIMIT ?`,
    [now, limit],
  );

  for (const order of stale) {
    const lines = await orderStockLines(db, order.id);
    await releaseReservation(db, lines, order.id);
    await db.batch([
      db.stmt(
        `UPDATE orders SET status = 'cancelled', cancel_reason = 'Payment was not completed in time.',
                cancelled_at = ?, reserved_until = NULL, updated_at = ?
          WHERE id = ? AND status = 'pending_payment'`,
        [now, now, order.id],
      ),
      orderEventStatement(db, {
        orderId: order.id,
        type: 'order.expired',
        message: 'Cancelled automatically because payment was not completed in time.',
        actorType: 'system',
      }),
    ]);
  }

  if (stale.length > 0) log.info('orders.reservations_expired', { count: stale.length });
  return stale.length;
}

/** Totals for the admin dashboard. */
export async function orderStats(db: Db): Promise<{
  todayOrders: number;
  todayRevenuePaise: number;
  pendingFulfilment: number;
  awaitingPayment: number;
  last30RevenuePaise: number;
  lifetimeOrders: number;
}> {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const monthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const row = await db.first<{
    today_orders: number;
    today_revenue: number;
    pending_fulfilment: number;
    awaiting_payment: number;
    last30_revenue: number;
    lifetime_orders: number;
  }>(
    `SELECT
       COUNT(CASE WHEN created_at >= ?1 AND payment_status = 'paid' THEN 1 END) AS today_orders,
       COALESCE(SUM(CASE WHEN created_at >= ?1 AND payment_status = 'paid' THEN total_paise END), 0) AS today_revenue,
       COUNT(CASE WHEN status IN ('confirmed','processing','packed') THEN 1 END) AS pending_fulfilment,
       COUNT(CASE WHEN status = 'pending_payment' THEN 1 END) AS awaiting_payment,
       COALESCE(SUM(CASE WHEN created_at >= ?2 AND payment_status = 'paid' THEN total_paise END), 0) AS last30_revenue,
       COUNT(*) AS lifetime_orders
     FROM orders`,
    [dayAgo, monthAgo],
  );

  return {
    todayOrders: row?.today_orders ?? 0,
    todayRevenuePaise: row?.today_revenue ?? 0,
    pendingFulfilment: row?.pending_fulfilment ?? 0,
    awaitingPayment: row?.awaiting_payment ?? 0,
    last30RevenuePaise: row?.last30_revenue ?? 0,
    lifetimeOrders: row?.lifetime_orders ?? 0,
  };
}
