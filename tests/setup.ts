/**
 * Test harness: schema, fixtures and the per-request container.
 *
 * This file is both the Vitest `setupFiles` entry (it applies the real
 * migrations to the test D1 before anything runs) and the module every test
 * imports its fixtures from. Keeping the two together means there is exactly one
 * description of what a "fresh shop" looks like.
 *
 * Three rules the whole suite depends on:
 *
 *  1. Every test starts from `freshDatabase()`. Rows are deleted explicitly
 *     rather than relying on the pool's storage isolation, so a test's result
 *     never depends on which test ran before it — or on whether isolation is
 *     enabled at all.
 *  2. The `Env` is written out in full here, never read from wrangler.jsonc or
 *     .dev.vars. Those carry production values and a gitignored developer file
 *     respectively; depending on them makes the suite pass on one machine and
 *     fail on a fresh clone.
 *  3. `ctx.waitUntil` collects its promises instead of dropping them, and
 *     `flushWaitUntil(ctx)` awaits them. Email dispatch runs in `waitUntil`, so
 *     without this a test would either race the outbox or leave I/O in flight
 *     after the test ended.
 */

import { applyD1Migrations, env as bindings } from 'cloudflare:test';

import { AppContext, type SessionUser } from '../src/lib/context';
import { Db } from '../src/lib/db/client';
import type { AddressSnapshot, CouponRow, EmailOutboxRow, InventoryRow, OrderRow, UserRow } from '../src/lib/db/types';
import type { Env } from '../src/lib/env';
import { DEFAULT_SETTINGS, type StoreSettings } from '../src/lib/settings';
import { addItem, getCart } from '../src/lib/services/cart';
import { createOrder, type CreateOrderResult } from '../src/lib/services/orders';
import { zoneForPincode } from '../src/lib/shipping-zones';

interface TestBindings {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testBindings = bindings as unknown as TestBindings;

// Top-level await: the setup file is fully evaluated before the first test in
// the file it is attached to, so the schema is always in place.
await applyD1Migrations(testBindings.DB, testBindings.TEST_MIGRATIONS);

/** The raw D1 binding, wrapped in the same helper the services use. */
export const db = new Db(testBindings.DB);

// ─── Environment ─────────────────────────────────────────────────────────────

/**
 * `test` rather than `development` because `appEnv()` recognises it and
 * `isDeployedEnv()` does not — precisely the combination the provider factories
 * need to resolve to mocks without an ALLOW_MOCK_PROVIDERS escape hatch.
 */
export const TEST_SESSION_SECRET = 'test-session-secret-0123456789abcdef';
export const TEST_SITE_URL = 'http://localhost:4321';
export const TEST_SUPPORT_EMAIL = 'orders@mothersgoldspice.test';

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: testBindings.DB,
    APP_ENV: 'test',
    PUBLIC_SITE_URL: TEST_SITE_URL,
    STORE_NAME: "Mother's Gold Spice",
    SUPPORT_EMAIL: TEST_SUPPORT_EMAIL,
    SESSION_SECRET: TEST_SESSION_SECRET,
    EMAIL_PROVIDER: 'mock',
    EMAIL_FROM: 'orders@mothersgoldspice.test',
    EMAIL_FROM_NAME: "Mother's Gold Spice",
    PAYMENT_PROVIDER: 'mock',
    SHIPPING_PROVIDER: 'mock',
    ALLOW_MOCK_PROVIDERS: 'true',
    ...overrides,
  };
}

// ─── AppContext ──────────────────────────────────────────────────────────────

const deferred = new WeakMap<AppContext, Promise<unknown>[]>();

export interface ContextOptions {
  user?: SessionUser | null;
  cartId?: string | null;
  clientIp?: string;
  env?: Partial<Env>;
}

/**
 * The same container src/middleware.ts builds for a real request, with the mock
 * email / payment / shipping providers resolved from the test `Env`.
 */
export function createContext(opts: ContextOptions = {}): AppContext {
  const promises: Promise<unknown>[] = [];
  const ctx = new AppContext(
    testEnv(opts.env),
    new URL(`${TEST_SITE_URL}/`),
    opts.clientIp ?? '203.0.113.7',
    'req_test',
    (promise) => {
      promises.push(promise);
    },
  );
  ctx.user = opts.user ?? null;
  ctx.cartId = opts.cartId ?? null;
  deferred.set(ctx, promises);
  return ctx;
}

/** Await everything the context handed to `waitUntil` — email dispatch, mostly. */
export async function flushWaitUntil(ctx: AppContext): Promise<void> {
  const promises = deferred.get(ctx);
  if (!promises) return;
  // A dispatch can itself queue more work, so drain until the queue stays empty.
  while (promises.length > 0) {
    await Promise.allSettled(promises.splice(0, promises.length));
  }
}

/** A signed-in user shaped the way the session middleware would produce one. */
export function sessionUser(user: UserRow): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    emailVerified: user.email_verified_at !== null,
  };
}

// ─── Settings ────────────────────────────────────────────────────────────────

/**
 * Store settings for a pure-function test. `loadSettings` returns exactly
 * `DEFAULT_SETTINGS` for a database with no overrides row, so a test that builds
 * settings this way and one that reads them through `ctx.settings()` agree.
 */
export function testSettings(overrides: Partial<StoreSettings> = {}): StoreSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    shippingRates: { ...DEFAULT_SETTINGS.shippingRates, ...(overrides.shippingRates ?? {}) },
    parcelDimensionsCm: { ...DEFAULT_SETTINGS.parcelDimensionsCm, ...(overrides.parcelDimensionsCm ?? {}) },
  };
}

// ─── Catalogue fixture ───────────────────────────────────────────────────────

/** One literal timestamp for every seeded row, so nothing in the suite drifts. */
export const SEED_AT = 1_784_000_000_000;

export const SEED = {
  pickle: {
    productId: 'prd_test_pickle',
    slug: 'mango-mustard-pickle',
    name: 'Mango Mustard Pickle',
    /** ₹299, 250 g jar. 20 on the shelf. */
    small: { id: 'var_test_250', sku: 'MGS-MNG-250', pricePaise: 29_900, shipWeightGrams: 320, onHand: 20 },
    /** ₹549, 500 g jar. 10 on the shelf. */
    large: { id: 'var_test_500', sku: 'MGS-MNG-500', pricePaise: 54_900, shipWeightGrams: 620, onHand: 10 },
    /**
     * A catering size that is made to order: an active variant with NO inventory
     * row at all. It is in the fixture on purpose — `checkAvailability` skips a
     * variant it has no row for, while `reserveStock`'s conditional UPDATE still
     * matches nothing, and that is the one deterministic way to reach the
     * partial-failure compensation path.
     */
    catering: { id: 'var_test_1kg', sku: 'MGS-MNG-1000', pricePaise: 99_900, shipWeightGrams: 1150 },
  },
  chutney: {
    productId: 'prd_test_chutney',
    slug: 'coriander-chutney',
    name: 'Coriander Chutney',
    /** ₹249, 200 g. Down to 4 — below the reorder level. */
    jar: { id: 'var_test_chut', sku: 'MGS-CHT-200', pricePaise: 24_900, shipWeightGrams: 260, onHand: 4 },
  },
} as const;

/**
 * Tables emptied between tests, children before parents.
 *
 * D1 enforces foreign keys, so the order is load-bearing: deleting `products`
 * before `order_items` would cascade a variant delete into rows a test still
 * expects to be able to read.
 */
const TABLES_CHILD_FIRST = [
  'inventory_ledger',
  'inventory',
  'cart_items',
  'carts',
  'coupon_redemptions',
  'order_items',
  'order_events',
  'refunds',
  'payments',
  'shipment_events',
  'shipments',
  'product_reviews',
  'stock_alerts',
  'orders',
  'coupons',
  'product_variants',
  'products',
  'addresses',
  'auth_tokens',
  'sessions',
  'notifications',
  'email_outbox',
  'email_suppressions',
  'newsletter_subscribers',
  'webhook_events',
  'rate_limits',
  'audit_log',
  'settings',
  'users',
  'mock_provider_state',
  'pincode_cache',
];

/** Empty every business table. The migration bookkeeping table is left alone. */
export async function resetDatabase(): Promise<void> {
  await db.batch(TABLES_CHILD_FIRST.map((table) => db.stmt(`DELETE FROM ${table}`)));
}

/** Two live products, four variants, stock on three of them. */
export async function seedCatalogue(): Promise<void> {
  const { pickle, chutney } = SEED;

  const product = (id: string, slug: string, name: string, sort: number) =>
    db.stmt(
      `INSERT INTO products (id, slug, name, subtitle, description, category, status, hero_image,
                             images_json, ingredients, allergens, shelf_life_months, storage_note,
                             is_veg, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, 'Small batch, Bangalore', 'Made in small batches.', 'pickle', 'active',
               '/mango-jar.png', '["/mango-jar.png"]', 'Raw mango, mustard oil, salt, spices.',
               'Contains mustard.', 12, 'Cool, dry place. Refrigerate after opening.', 1, ?, ?, ?)`,
      [id, slug, name, sort, SEED_AT, SEED_AT],
    );

  const variant = (
    id: string,
    productId: string,
    sku: string,
    name: string,
    weightGrams: number,
    shipWeightGrams: number,
    pricePaise: number,
    sort: number,
  ) =>
    db.stmt(
      `INSERT INTO product_variants (id, product_id, sku, name, weight_grams, shipping_weight_grams,
                                     price_paise, compare_at_price_paise, hsn_code, gst_rate_bps,
                                     status, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '20019000', 1200, 'active', ?, ?, ?)`,
      [id, productId, sku, name, weightGrams, shipWeightGrams, pricePaise, sort, SEED_AT, SEED_AT],
    );

  const stock = (variantId: string, onHand: number) =>
    db.stmt(
      `INSERT INTO inventory (variant_id, on_hand, reserved, reorder_level, track, updated_at)
       VALUES (?, ?, 0, 6, 1, ?)`,
      [variantId, onHand, SEED_AT],
    );

  await db.batch([
    product(pickle.productId, pickle.slug, pickle.name, 10),
    product(chutney.productId, chutney.slug, chutney.name, 20),
    variant(pickle.small.id, pickle.productId, pickle.small.sku, '250 g', 250, pickle.small.shipWeightGrams, pickle.small.pricePaise, 1),
    variant(pickle.large.id, pickle.productId, pickle.large.sku, '500 g', 500, pickle.large.shipWeightGrams, pickle.large.pricePaise, 2),
    variant(pickle.catering.id, pickle.productId, pickle.catering.sku, '1 kg', 1000, pickle.catering.shipWeightGrams, pickle.catering.pricePaise, 3),
    variant(chutney.jar.id, chutney.productId, chutney.jar.sku, '200 g', 200, chutney.jar.shipWeightGrams, chutney.jar.pricePaise, 1),
    stock(pickle.small.id, pickle.small.onHand),
    stock(pickle.large.id, pickle.large.onHand),
    stock(chutney.jar.id, chutney.jar.onHand),
  ]);
}

/** Reset and reseed. Call this from a `beforeEach` in every test file. */
export async function freshDatabase(): Promise<void> {
  await resetDatabase();
  await seedCatalogue();
}

// ─── Row fixtures ────────────────────────────────────────────────────────────

export interface CreateUserOptions {
  email?: string;
  name?: string;
  role?: UserRow['role'];
  /** Stored verbatim. Tests needing a verifiable hash pass `hashPassword(...)`. */
  passwordHash?: string | null;
  verified?: boolean;
}

export async function createUser(opts: CreateUserOptions = {}): Promise<UserRow> {
  const now = Date.now();
  const email = (opts.email ?? 'asha@example.com').toLowerCase();
  const id = `usr_test_${email.replace(/[^a-z0-9]/g, '').slice(0, 24)}`;
  await db.run(
    `INSERT INTO users (id, email, email_verified_at, password_hash, name, phone, role, status,
                        marketing_opt_in, failed_logins, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '+919845012345', ?, 'active', 0, 0, ?, ?)`,
    [
      id,
      email,
      opts.verified === false ? null : now,
      opts.passwordHash ?? null,
      opts.name ?? 'Asha Rao',
      opts.role ?? 'customer',
      now,
      now,
    ],
  );
  return (await db.first<UserRow>('SELECT * FROM users WHERE id = ?', [id])) as UserRow;
}

let cartsCreated = 0;

/** An empty active cart. Carts are addressed by id in tests, never by cookie. */
export async function createCart(userId: string | null = null, id?: string): Promise<string> {
  cartsCreated += 1;
  const cartId = id ?? `crt_test_${cartsCreated}`;
  const now = Date.now();
  await db.run(
    `INSERT INTO carts (id, user_id, status, currency, created_at, updated_at, expires_at)
     VALUES (?, ?, 'active', 'INR', ?, ?, ?)`,
    [cartId, userId, now, now, now + 30 * 24 * 60 * 60 * 1000],
  );
  return cartId;
}

/** Add through the cart service, so the caps and availability checks run. */
export async function addToCart(
  cartId: string,
  variantId: string,
  qty: number,
  settings?: StoreSettings,
): Promise<void> {
  await addItem(db, cartId, variantId, qty, settings ?? testSettings());
}

export function testAddress(overrides: Partial<AddressSnapshot> = {}): AddressSnapshot {
  return {
    full_name: 'Asha Rao',
    phone: '+919845012345',
    line1: '14, 3rd Cross, Jayanagar',
    line2: null,
    landmark: 'Near the water tank',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560041',
    country: 'IN',
    ...overrides,
  };
}

export interface PlaceOrderOptions {
  cartId: string;
  email?: string;
  userId?: string | null;
  isGuest?: boolean;
  paymentMethod?: 'prepaid' | 'cod';
  shippingAddress?: AddressSnapshot;
  idempotencyKey?: string | null;
  settings?: StoreSettings;
}

/**
 * Cart → order, through the real service. The cart view is rebuilt from the
 * database first, exactly as the checkout route does, so pricing is never taken
 * from anything a test hand-assembled.
 */
export async function placeOrder(ctx: AppContext, opts: PlaceOrderOptions): Promise<CreateOrderResult> {
  const settings = opts.settings ?? (await ctx.settings());
  const address = opts.shippingAddress ?? testAddress();
  const cart = await getCart(db, opts.cartId, settings, {
    zone: zoneForPincode(address.pincode),
    paymentMethod: opts.paymentMethod ?? 'prepaid',
    userId: opts.userId ?? null,
  });

  // `return await`, not `return`. `createOrder` rejects synchronously for an
  // empty cart or a closed store, and returning that promise unawaited leaves it
  // handler-less for a microtask — long enough for workerd to report it as an
  // unhandled rejection even though the test is awaiting it.
  return await createOrder(ctx, {
    cart,
    settings,
    email: opts.email ?? 'asha@example.com',
    customerName: address.full_name,
    phone: address.phone,
    shippingAddress: address,
    billingAddress: address,
    paymentMethod: opts.paymentMethod ?? 'prepaid',
    shippingMethod: 'surface',
    customerNote: null,
    userId: opts.userId ?? null,
    isGuest: opts.isGuest ?? true,
    idempotencyKey: opts.idempotencyKey ?? null,
  });
}

export interface CouponOptions extends Partial<CouponRow> {
  code: string;
}

export async function createCoupon(opts: CouponOptions): Promise<CouponRow> {
  const now = Date.now();
  const row: CouponRow = {
    id: opts.id ?? `cpn_test_${opts.code.toLowerCase()}`,
    code: opts.code.toUpperCase(),
    description: opts.description ?? '',
    type: opts.type ?? 'percent',
    value: opts.value ?? 1000,
    min_subtotal_paise: opts.min_subtotal_paise ?? 0,
    max_discount_paise: opts.max_discount_paise ?? null,
    starts_at: opts.starts_at ?? null,
    ends_at: opts.ends_at ?? null,
    usage_limit: opts.usage_limit ?? null,
    per_user_limit: opts.per_user_limit ?? 1,
    used_count: opts.used_count ?? 0,
    first_order_only: opts.first_order_only ?? 0,
    status: opts.status ?? 'active',
    provider_discount_id: null,
    created_at: now,
    updated_at: now,
  };

  await db.run(
    `INSERT INTO coupons (id, code, description, type, value, min_subtotal_paise, max_discount_paise,
                          starts_at, ends_at, usage_limit, per_user_limit, used_count, first_order_only,
                          status, provider_discount_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.code,
      row.description,
      row.type,
      row.value,
      row.min_subtotal_paise,
      row.max_discount_paise,
      row.starts_at,
      row.ends_at,
      row.usage_limit,
      row.per_user_limit,
      row.used_count,
      row.first_order_only,
      row.status,
      row.provider_discount_id,
      row.created_at,
      row.updated_at,
    ],
  );
  return row;
}

// ─── Read-back helpers ───────────────────────────────────────────────────────

export async function inventoryOf(variantId: string): Promise<InventoryRow | null> {
  return db.first<InventoryRow>('SELECT * FROM inventory WHERE variant_id = ?', [variantId]);
}

export async function availableOf(variantId: string): Promise<number> {
  const row = await inventoryOf(variantId);
  return row ? row.on_hand - row.reserved : 0;
}

export async function reloadOrder(orderId: string): Promise<OrderRow> {
  return (await db.first<OrderRow>('SELECT * FROM orders WHERE id = ?', [orderId])) as OrderRow;
}

export async function outboxRows(orderId?: string): Promise<EmailOutboxRow[]> {
  return orderId
    ? db.all<EmailOutboxRow>('SELECT * FROM email_outbox WHERE order_id = ? ORDER BY created_at, id', [orderId])
    : db.all<EmailOutboxRow>('SELECT * FROM email_outbox ORDER BY created_at, id');
}

/** Every email queued (for an order, or in total), oldest first, as template ids. */
export async function outboxTemplates(orderId?: string): Promise<string[]> {
  return (await outboxRows(orderId)).map((r) => r.template);
}

/** Timeline event types recorded against an order, oldest first. */
export async function orderEventTypes(orderId: string): Promise<string[]> {
  const rows = await db.all<{ type: string }>(
    'SELECT type FROM order_events WHERE order_id = ? ORDER BY created_at, id',
    [orderId],
  );
  return rows.map((r) => r.type);
}

// ─── Deterministic randomness ────────────────────────────────────────────────

/**
 * A seeded PRNG for the property-style money tests.
 *
 * `Math.random()` would make a failure unreproducible, which is the one thing a
 * property test must not be. mulberry32 is 32 bits of state and four lines,
 * which is plenty for generating basket amounts.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
