/**
 * The catalogue, from the seller's side.
 *
 * This is the route that makes a price changeable without hand-written SQL, so
 * it is written defensively in four specific places:
 *
 *   1. Money arrives as integer paise and is CHECKED, never coerced. `"499abc"`
 *      quietly becoming 499 is exactly how a wrong price ships — the same
 *      reasoning as src/pages/api/admin/settings.ts.
 *   2. `gst_rate_bps` is basis points and must land on a real GST slab. The form
 *      shows 12 and sends 1200; a body carrying a bare 12 is a form that lost
 *      its conversion, and 0.12% GST on every jar would go unnoticed until an
 *      auditor found it. So 12 is rejected rather than helpfully accepted.
 *   3. A new variant gets an inventory row in the same batch, tracked and at
 *      zero. Without it the variant has no inventory row, which the storefront
 *      reads as "not stock-tracked" and therefore always in stock — a brand new
 *      SKU would be sellable before a single jar existed.
 *   4. DELETE archives. There is no destructive write in this file.
 *
 * Editing a price here cannot touch an order that already exists. `createOrder`
 * in src/lib/services/orders.ts copies product_name, variant_name,
 * unit_price_paise, tax_rate_bps, hsn_code and weight_grams onto `order_items`
 * at placement — an order is a snapshot, so a catalogue edit tomorrow cannot
 * rewrite what somebody bought today, and an invoice regenerated in two years
 * still shows the price that was actually charged.
 */

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdmin } from '../../../lib/api';
import type { AppContext } from '../../../lib/context';
import type { SqlValue } from '../../../lib/db/client';
import { toInt } from '../../../lib/db/client';
import type { ProductRow, VariantRow } from '../../../lib/db/types';
import { badRequest, conflict, notFound } from '../../../lib/errors';
import { created, handle, ok, readJson } from '../../../lib/http';
import { newId } from '../../../lib/ids';
import { log } from '../../../lib/log';
import { formatPaise } from '../../../lib/money';
import { getAdminProduct, listAdminCatalogue, type AdminProductView } from '../../../lib/services/catalog';
import { parseOrThrow } from '../../../lib/validate';

export const prerender = false;

// ─────────────────────────────────────────────────────────────────────────────
// Field schemas
// ─────────────────────────────────────────────────────────────────────────────

const idSchema = z.string().trim().min(1, 'That reference is missing.').max(64);

/**
 * `mango-mustard-pickle`. Lowercase, digits and single hyphens — this ends up in
 * a URL customers share, so no spaces, no case, no trailing punctuation.
 */
const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'A slug needs at least two characters.')
  .max(80, 'That slug is too long for a tidy URL.')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slugs are lowercase words joined by single hyphens, like mango-pickle.');

/** Free text, but shaped like a slug so it stays usable as a /shop?category= filter. */
const categorySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'Give the product a category.')
  .max(40, 'That category name is too long.')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Categories are lowercase words joined by hyphens, like pickle or spice-mix.');

/**
 * Money. The ceiling is a sanity rail rather than a business limit: nothing this
 * kitchen sells is anywhere near ₹1,00,000 a jar, so a number above it is almost
 * certainly rupees typed straight into a paise field.
 */
const paise = z
  .number({ invalid_type_error: 'Enter a price in rupees — the form converts it to paise before sending.' })
  .int('Prices are whole paise. Type rupees into the form and it converts.')
  .min(0, 'A price cannot be negative.')
  .max(10_000_000, 'That is over ₹1,00,000 for one jar. Check whether rupees went into a paise field.');

/** Blank clears the strike-through price; that is a real edit (a sale ending). */
const nullablePaise = z.union([paise, z.null()]);

const grams = z
  .number({ invalid_type_error: 'Enter a weight in grams, as a plain number.' })
  .int('Weights are whole grams.')
  .min(1, 'A weight has to be at least one gram.')
  .max(50_000, 'That is over 50 kg for one unit. Check the number.');

const sortOrderSchema = z
  .number({ invalid_type_error: 'Enter a sort position, as a plain number.' })
  .int('Sort positions are whole numbers.')
  .min(0, 'A sort position cannot be negative.')
  .max(100_000, 'That sort position is far higher than we need.');

const shelfLifeSchema = z.union([
  z
    .number({ invalid_type_error: 'Enter a shelf life in whole months.' })
    .int('Shelf life is a whole number of months.')
    .min(1, 'A shelf life of under a month is not a shelf life.')
    .max(120, 'Ten years is longer than any food we sell keeps.'),
  z.null(),
]);

/**
 * India's GST slabs, in basis points. A closed set rather than a range, because
 * the failure this guards against is silent: a form that lost its percent →
 * basis-points conversion sends `12`, which as a rate is 0.12%, which prices
 * every jar wrong in a way nothing on the site would show. 12 is not a slab, so
 * it is refused loudly instead.
 */
const GST_SLABS_BPS = [0, 500, 1200, 1800, 2800] as const;

const gstRateSchema = z
  .number({ invalid_type_error: 'Choose a GST rate.' })
  .int('GST rates are whole basis points — 12% is 1200.')
  .refine(
    (v) => (GST_SLABS_BPS as readonly number[]).includes(v),
    'That is not a GST slab. Use 0, 5, 12, 18 or 28 per cent — sent as 0, 500, 1200, 1800 or 2800 basis points.',
  );

/** HSN drives the rate an auditor expects, so it is checked for shape, not just length. */
const hsnSchema = z
  .string()
  .trim()
  .regex(/^\d{4}(\d{2}(\d{2})?)?$/, 'An HSN code is 4, 6 or 8 digits, like 20019000.');

/** A site path or a full https URL. A bare "mango.webp" 404s on the storefront. */
const imageRef = z
  .string()
  .trim()
  .max(300, 'That image path is too long.')
  .refine(
    (v) => v === '' || v.startsWith('/') || v.startsWith('https://'),
    'Use a site path like /mango-jar.webp, or a full https:// URL.',
  );

/**
 * Extra images. Accepts a JSON array, or the newline-separated text the editor's
 * textarea sends — one field, two encodings, so the console and a script calling
 * the API directly do not need different shapes.
 */
const imagesSchema = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : v.split('\n')))
  .transform((list) => [...new Set(list.map((s) => s.trim()).filter((s) => s.length > 0))])
  .refine((list) => list.length <= 12, 'Twelve images is plenty for one product.')
  .refine(
    (list) => list.every((src) => src.startsWith('/') || src.startsWith('https://')),
    'Each image is a site path like /mango-jar.webp, or a full https:// URL.',
  );

// ─────────────────────────────────────────────────────────────────────────────
// Request schemas
//
// `.strict()` throughout: an unrecognised key here is a typo in a form, and a
// silently ignored `price_pasie` is a price that did not change while the screen
// said it did.
// ─────────────────────────────────────────────────────────────────────────────

const productFields = z.object({
  name: z.string().trim().min(2, 'Give the product a name.').max(120, 'That name is too long.'),
  slug: slugSchema.optional(),
  subtitle: z.string().trim().max(160, 'Keep the subtitle under 160 characters.').optional(),
  description: z.string().trim().max(4000, 'That description is very long — keep it under 4000 characters.').optional(),
  category: categorySchema.optional(),
  status: z.enum(['draft', 'active', 'archived'], {
    errorMap: () => ({ message: 'Status is draft, active or archived.' }),
  }).optional(),
  hero_image: imageRef.optional(),
  images: imagesSchema.optional(),
  ingredients: z.string().trim().max(2000, 'That ingredients list is too long.').optional(),
  allergens: z.string().trim().max(500, 'That allergen note is too long.').optional(),
  shelf_life_months: shelfLifeSchema.optional(),
  storage_note: z.string().trim().max(1000, 'That storage note is too long.').optional(),
  is_veg: z.boolean({ invalid_type_error: 'The vegetarian flag is a yes or no.' }).optional(),
  sort_order: sortOrderSchema.optional(),
});

const productCreateSchema = productFields.strict();

const productPatchSchema = productFields
  .partial()
  .extend({ product_id: idSchema })
  .strict()
  .refine((v) => Object.keys(v).length > 1, 'There is nothing to save.');

const variantFields = z.object({
  sku: z
    .string()
    .trim()
    .toUpperCase()
    .min(3, 'Give the variant an SKU.')
    .max(40, 'That SKU is too long.')
    .regex(/^[A-Z0-9][A-Z0-9-]*$/, 'SKUs are capitals, digits and hyphens, like MGS-MMP-250.'),
  name: z.string().trim().min(1, 'Name the variant — the jar size, usually.').max(60, 'That variant name is too long.'),
  weight_grams: grams,
  shipping_weight_grams: grams,
  price_paise: paise,
  compare_at_price_paise: nullablePaise.optional(),
  hsn_code: hsnSchema.optional(),
  gst_rate_bps: gstRateSchema.optional(),
  status: z.enum(['active', 'archived'], {
    errorMap: () => ({ message: 'A variant is active or archived.' }),
  }).optional(),
  sort_order: sortOrderSchema.optional(),
});

const variantCreateSchema = variantFields.extend({ product_id: idSchema }).strict();

const variantPatchSchema = variantFields
  .partial()
  .extend({ variant_id: idSchema })
  .strict()
  .refine((v) => Object.keys(v).length > 1, 'There is nothing to save.');

const archiveSchema = z
  .object({ product_id: idSchema.optional(), variant_id: idSchema.optional() })
  .strict()
  .refine((v) => Boolean(v.product_id) !== Boolean(v.variant_id), 'Name either a product or a variant to archive.');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** "Mango Mustard Pickle" → "mango-mustard-pickle". */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    // Strip the combining marks NFKD just split off, so "Nimbu" with a macron
    // becomes "nimbu" rather than "nimb-u" once the accent turns into a hyphen.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/**
 * Build a SET clause from a column → value map.
 *
 * Column names come from the literal `put(...)` calls below, never from the
 * request body, so nothing user-supplied is interpolated into SQL. Values are
 * always bound.
 */
function buildUpdate(columns: Record<string, SqlValue>): { sql: string; params: SqlValue[] } {
  const names = Object.keys(columns);
  return {
    sql: names.map((c) => `${c} = ?`).join(', '),
    params: names.map((c) => columns[c]),
  };
}

/** Collect only the columns the caller actually sent. */
function collector(): { cols: Record<string, SqlValue>; put: (column: string, value: SqlValue | undefined) => void } {
  const cols: Record<string, SqlValue> = {};
  return {
    cols,
    put: (column, value) => {
      if (value !== undefined) cols[column] = value;
    },
  };
}

async function writeAudit(
  ctx: AppContext,
  actorId: string,
  action: string,
  entityType: 'product' | 'variant',
  entityId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await ctx.db.run(
    `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, data_json, ip, created_at)
     VALUES (?, 'admin', ?, ?, ?, ?, ?, ?, ?)`,
    [newId('aud'), actorId, action, entityType, entityId, JSON.stringify(data), ctx.clientIp, Date.now()],
  );
}

/** Infinity is not JSON, and an untracked variant has no meaningful count. */
function toJson(p: AdminProductView): Record<string, unknown> {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    subtitle: p.subtitle,
    description: p.description,
    category: p.category,
    status: p.status,
    heroImage: p.heroImage,
    images: p.images,
    ingredients: p.ingredients,
    allergens: p.allergens,
    shelfLifeMonths: p.shelfLifeMonths,
    storageNote: p.storageNote,
    isVeg: p.isVeg,
    sortOrder: p.sortOrder,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    activeVariantCount: p.activeVariantCount,
    minPricePaise: p.minPricePaise,
    maxPricePaise: p.maxPricePaise,
    totalOnHand: p.totalOnHand,
    orderLineCount: p.orderLineCount,
    everOrdered: p.orderLineCount > 0,
    showsAsSoldOut: p.showsAsSoldOut,
    variants: p.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      name: v.name,
      weightGrams: v.weightGrams,
      shippingWeightGrams: v.shippingWeightGrams,
      pricePaise: v.pricePaise,
      compareAtPricePaise: v.compareAtPricePaise,
      hsnCode: v.hsnCode,
      gstRateBps: v.gstRateBps,
      status: v.status,
      sortOrder: v.sortOrder,
      onHand: v.onHand,
      reserved: v.reserved,
      available: v.tracked ? Math.max(0, v.available) : null,
      reorderLevel: v.reorderLevel,
      tracked: v.tracked,
      sellable: v.sellable,
      orderLineCount: v.orderLineCount,
      everOrdered: v.orderLineCount > 0,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — the whole catalogue, every status
// ─────────────────────────────────────────────────────────────────────────────

export const GET: APIRoute = async ({ locals }) =>
  handle(async () => {
    const { ctx } = requireAdmin(locals);
    const products = await listAdminCatalogue(ctx.db);

    return ok({
      products: products.map(toJson),
      // Surfaced rather than left to the caller to derive: an active product
      // with nothing buyable on it renders as a permanently sold-out card, and
      // nothing on the storefront makes that visible.
      soldOutOnShop: products.filter((p) => p.showsAsSoldOut).map((p) => p.id),
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// POST — create a product, or a variant of one
// ─────────────────────────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireAdmin(locals);
    const body = await readJson<Record<string, unknown>>(request);

    // Which of the two creates this is, decided by the shape of the body rather
    // than a mode flag the caller has to remember — the same way inventory.ts
    // picks between its two writes. `product_id` names the product a new variant
    // belongs to; without it there is no parent, so this is a new product.
    return Object.prototype.hasOwnProperty.call(body, 'product_id')
      ? createVariant(ctx, user.id, body)
      : createProduct(ctx, user.id, body);
  });

async function createProduct(ctx: AppContext, actorId: string, body: unknown): Promise<Response> {
  const input = parseOrThrow(productCreateSchema, body);

  const slug = input.slug ?? slugify(input.name);
  if (!slug) {
    throw badRequest('That name has no letters or digits to build a slug from. Enter a slug by hand.');
  }

  // Refused, not silently suffixed. `mango-pickle-2` created behind somebody's
  // back is a URL nobody meant to publish and a duplicate nobody notices.
  const clash = await ctx.db.first<{ id: string; name: string }>('SELECT id, name FROM products WHERE slug = ?', [
    slug,
  ]);
  if (clash) {
    throw conflict(`The slug "${slug}" is already used by "${clash.name}". Choose a different one.`);
  }

  const id = newId('prd');
  const now = Date.now();

  await ctx.db.run(
    `INSERT INTO products (
       id, slug, name, subtitle, description, category, status,
       hero_image, images_json, ingredients, allergens,
       shelf_life_months, storage_note, is_veg, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      slug,
      input.name,
      input.subtitle ?? '',
      input.description ?? '',
      input.category ?? 'pickle',
      // Draft by default. A product created mid-thought must not appear on the
      // storefront before its variants, price and photographs exist.
      input.status ?? 'draft',
      input.hero_image ? input.hero_image : null,
      JSON.stringify(input.images ?? []),
      input.ingredients ?? '',
      input.allergens ?? '',
      input.shelf_life_months ?? null,
      input.storage_note ?? '',
      toInt(input.is_veg ?? true),
      input.sort_order ?? 0,
      now,
      now,
    ],
  );

  await writeAudit(ctx, actorId, 'product.create', 'product', id, {
    slug,
    name: input.name,
    status: input.status ?? 'draft',
    category: input.category ?? 'pickle',
  });
  log.info('admin.product_created', { productId: id, slug, actorId });

  const view = await getAdminProduct(ctx.db, id);
  if (!view) throw badRequest('That product did not save. Please try again.');
  return created(toJson(view));
}

async function createVariant(ctx: AppContext, actorId: string, body: unknown): Promise<Response> {
  const input = parseOrThrow(variantCreateSchema, body);

  const product = await ctx.db.first<Pick<ProductRow, 'id' | 'name'>>('SELECT id, name FROM products WHERE id = ?', [
    input.product_id,
  ]);
  if (!product) throw notFound('We could not find that product.');

  const skuClash = await ctx.db.first<{ id: string }>('SELECT id FROM product_variants WHERE sku = ?', [input.sku]);
  if (skuClash) throw conflict(`The SKU ${input.sku} is already in use. Every SKU has to be unique.`);

  const comparePaise = input.compare_at_price_paise ?? null;
  assertCompareAtIsAbove(comparePaise, input.price_paise);

  const id = newId('var');
  const now = Date.now();
  const gstRateBps = input.gst_rate_bps ?? 1200;
  const hsnCode = input.hsn_code ?? '20019000';

  await ctx.db.batch([
    ctx.db.stmt(
      `INSERT INTO product_variants (
         id, product_id, sku, name, weight_grams, shipping_weight_grams,
         price_paise, compare_at_price_paise, hsn_code, gst_rate_bps,
         status, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.product_id,
        input.sku,
        input.name,
        input.weight_grams,
        input.shipping_weight_grams,
        input.price_paise,
        comparePaise,
        hsnCode,
        gstRateBps,
        input.status ?? 'active',
        input.sort_order ?? 0,
        now,
        now,
      ],
    ),
    // Tracked, at zero, in the same atomic batch. A variant with no inventory
    // row reads as "not stock-tracked" to the storefront and is therefore
    // permanently in stock — a brand new SKU would be sellable before a single
    // jar had been made. Stock is then added on /admin/inventory, which is the
    // only place that writes a ledger row for it.
    ctx.db.stmt(
      `INSERT INTO inventory (variant_id, on_hand, reserved, reorder_level, track, updated_at)
       VALUES (?, 0, 0, 6, 1, ?)`,
      [id, now],
    ),
  ]);

  await writeAudit(ctx, actorId, 'variant.create', 'variant', id, {
    productId: input.product_id,
    productName: product.name,
    sku: input.sku,
    name: input.name,
    pricePaise: input.price_paise,
    gstRateBps,
    hsnCode,
  });
  log.info('admin.variant_created', { variantId: id, sku: input.sku, productId: input.product_id, actorId });

  const view = await getAdminProduct(ctx.db, input.product_id);
  if (!view) throw badRequest('That variant did not save. Please try again.');
  return created(toJson(view));
}

/** A strike-through price at or below the real one is a discount that is not one. */
function assertCompareAtIsAbove(comparePaise: number | null, pricePaise: number): void {
  if (comparePaise === null) return;
  if (comparePaise <= pricePaise) {
    throw badRequest(
      `The compare-at price (${formatPaise(comparePaise)}) has to be above the selling price (${formatPaise(pricePaise)}), or there is no saving to show. Leave it blank to remove it.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH — update a product, or a single variant
// ─────────────────────────────────────────────────────────────────────────────

export const PATCH: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireAdmin(locals);
    const body = await readJson<Record<string, unknown>>(request);

    // Same shape-driven dispatch as inventory.ts: `variant_id` edits one variant,
    // `product_id` edits the product itself.
    return Object.prototype.hasOwnProperty.call(body, 'variant_id')
      ? updateVariant(ctx, user.id, body)
      : updateProduct(ctx, user.id, body);
  });

async function updateProduct(ctx: AppContext, actorId: string, body: unknown): Promise<Response> {
  const input = parseOrThrow(productPatchSchema, body);

  const existing = await ctx.db.first<ProductRow>('SELECT * FROM products WHERE id = ?', [input.product_id]);
  if (!existing) throw notFound('We could not find that product.');

  // A slug change is allowed on purpose — a product genuinely gets renamed — but
  // it breaks every link and QR code already pointing at the old URL. The editor
  // warns about that; refusing it outright would be worse, because the operator
  // would edit the row by hand instead.
  if (input.slug !== undefined && input.slug !== existing.slug) {
    const clash = await ctx.db.first<{ id: string; name: string }>(
      'SELECT id, name FROM products WHERE slug = ? AND id <> ?',
      [input.slug, existing.id],
    );
    if (clash) throw conflict(`The slug "${input.slug}" is already used by "${clash.name}". Choose a different one.`);
  }

  const { cols, put } = collector();
  put('name', input.name);
  put('slug', input.slug);
  put('subtitle', input.subtitle);
  put('description', input.description);
  put('category', input.category);
  put('status', input.status);
  // Blank clears it: removing a photograph that no longer matches the jar is a
  // real edit, and "" in a nullable column would render as a broken image.
  put('hero_image', input.hero_image === undefined ? undefined : input.hero_image || null);
  put('images_json', input.images === undefined ? undefined : JSON.stringify(input.images));
  put('ingredients', input.ingredients);
  put('allergens', input.allergens);
  put('shelf_life_months', input.shelf_life_months);
  put('storage_note', input.storage_note);
  put('is_veg', input.is_veg === undefined ? undefined : toInt(input.is_veg));
  put('sort_order', input.sort_order);

  if (Object.keys(cols).length === 0) throw badRequest('There is nothing to save.');

  cols.updated_at = Date.now();
  const { sql, params } = buildUpdate(cols);
  await ctx.db.run(`UPDATE products SET ${sql} WHERE id = ?`, [...params, existing.id]);

  await writeAudit(ctx, actorId, 'product.update', 'product', existing.id, {
    changed: Object.keys(cols).filter((c) => c !== 'updated_at'),
    ...(input.slug !== undefined && input.slug !== existing.slug
      ? { slugFrom: existing.slug, slugTo: input.slug }
      : {}),
    ...(input.status !== undefined && input.status !== existing.status
      ? { statusFrom: existing.status, statusTo: input.status }
      : {}),
  });
  log.info('admin.product_updated', { productId: existing.id, actorId, changed: Object.keys(cols) });

  const view = await getAdminProduct(ctx.db, existing.id);
  if (!view) throw badRequest('That change did not take. Please try again.');
  return ok(toJson(view));
}

async function updateVariant(ctx: AppContext, actorId: string, body: unknown): Promise<Response> {
  const input = parseOrThrow(variantPatchSchema, body);

  const existing = await ctx.db.first<VariantRow>('SELECT * FROM product_variants WHERE id = ?', [input.variant_id]);
  if (!existing) throw notFound('We could not find that variant.');

  if (input.sku !== undefined && input.sku !== existing.sku) {
    const clash = await ctx.db.first<{ id: string }>('SELECT id FROM product_variants WHERE sku = ? AND id <> ?', [
      input.sku,
      existing.id,
    ]);
    if (clash) throw conflict(`The SKU ${input.sku} is already in use. Every SKU has to be unique.`);
  }

  // Checked against the MERGED result, not the handful of keys that arrived —
  // sending only a new selling price must not be able to cross a compare-at
  // price that was never in the patch. Same reasoning as settings.ts.
  const mergedPrice = input.price_paise ?? existing.price_paise;
  const mergedCompare =
    input.compare_at_price_paise === undefined ? existing.compare_at_price_paise : input.compare_at_price_paise;
  assertCompareAtIsAbove(mergedCompare, mergedPrice);

  const { cols, put } = collector();
  put('sku', input.sku);
  put('name', input.name);
  put('weight_grams', input.weight_grams);
  put('shipping_weight_grams', input.shipping_weight_grams);
  put('price_paise', input.price_paise);
  put('compare_at_price_paise', input.compare_at_price_paise);
  put('hsn_code', input.hsn_code);
  put('gst_rate_bps', input.gst_rate_bps);
  put('status', input.status);
  put('sort_order', input.sort_order);

  if (Object.keys(cols).length === 0) throw badRequest('There is nothing to save.');

  cols.updated_at = Date.now();
  const { sql, params } = buildUpdate(cols);
  await ctx.db.run(`UPDATE product_variants SET ${sql} WHERE id = ?`, [...params, existing.id]);

  // Price and tax movements are recorded from → to rather than as a bare "it
  // changed". Six months on, "why is this jar ₹80 dearer" is a question only the
  // audit trail can answer, and only if it kept both numbers.
  await writeAudit(ctx, actorId, 'variant.update', 'variant', existing.id, {
    productId: existing.product_id,
    sku: input.sku ?? existing.sku,
    changed: Object.keys(cols).filter((c) => c !== 'updated_at'),
    ...(input.price_paise !== undefined && input.price_paise !== existing.price_paise
      ? { pricePaiseFrom: existing.price_paise, pricePaiseTo: input.price_paise }
      : {}),
    ...(input.gst_rate_bps !== undefined && input.gst_rate_bps !== existing.gst_rate_bps
      ? { gstRateBpsFrom: existing.gst_rate_bps, gstRateBpsTo: input.gst_rate_bps }
      : {}),
    ...(input.status !== undefined && input.status !== existing.status
      ? { statusFrom: existing.status, statusTo: input.status }
      : {}),
  });
  log.info('admin.variant_updated', { variantId: existing.id, actorId, changed: Object.keys(cols) });

  const view = await getAdminProduct(ctx.db, existing.product_id);
  if (!view) throw badRequest('That change did not take. Please try again.');
  return ok(toJson(view));
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE — archive, and only ever archive
// ─────────────────────────────────────────────────────────────────────────────

/**
 * There is no row deletion here, and there must never be one.
 *
 * `order_items` holds a `product_id` and a `variant_id` for every line ever
 * sold. Deleting the product would leave those lines pointing at nothing, and an
 * archived product must still render on a two-year-old invoice — the invoice is
 * regenerated from the order, and the catalogue row is what the fulfilment and
 * accounting screens join back to when an operator asks what a line was.
 *
 * Archiving is also reversible: PATCH the status back to draft or active and the
 * product returns, which a DELETE could never offer.
 */
export const DELETE: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireAdmin(locals);
    const input = parseOrThrow(archiveSchema, await readJson<Record<string, unknown>>(request));
    const now = Date.now();

    if (input.variant_id) {
      const variant = await ctx.db.first<VariantRow>('SELECT * FROM product_variants WHERE id = ?', [input.variant_id]);
      if (!variant) throw notFound('We could not find that variant.');
      if (variant.status === 'archived') throw conflict('That variant is already archived.');

      await ctx.db.run("UPDATE product_variants SET status = 'archived', updated_at = ? WHERE id = ?", [
        now,
        variant.id,
      ]);

      const orderLines =
        (await ctx.db.scalar<number>('SELECT COUNT(*) FROM order_items WHERE variant_id = ?', [variant.id])) ?? 0;

      await writeAudit(ctx, user.id, 'variant.archive', 'variant', variant.id, {
        productId: variant.product_id,
        sku: variant.sku,
        pricePaise: variant.price_paise,
        orderLines,
      });
      log.info('admin.variant_archived', { variantId: variant.id, sku: variant.sku, actorId: user.id, orderLines });

      const view = await getAdminProduct(ctx.db, variant.product_id);
      if (!view) throw badRequest('That variant did not archive. Please try again.');
      return ok(toJson(view));
    }

    const productId = input.product_id ?? '';
    const product = await ctx.db.first<ProductRow>('SELECT * FROM products WHERE id = ?', [productId]);
    if (!product) throw notFound('We could not find that product.');
    if (product.status === 'archived') throw conflict('That product is already archived.');

    // Variants are deliberately left as they are. Archiving the product already
    // takes it off the shop and out of the stock screen, and leaving the variants
    // alone means un-archiving restores the product exactly as it was rather
    // than as a shell somebody has to re-activate row by row.
    await ctx.db.run("UPDATE products SET status = 'archived', updated_at = ? WHERE id = ?", [now, product.id]);

    const orderLines =
      (await ctx.db.scalar<number>('SELECT COUNT(*) FROM order_items WHERE product_id = ?', [product.id])) ?? 0;

    await writeAudit(ctx, user.id, 'product.archive', 'product', product.id, {
      slug: product.slug,
      name: product.name,
      statusFrom: product.status,
      orderLines,
    });
    log.info('admin.product_archived', { productId: product.id, slug: product.slug, actorId: user.id, orderLines });

    const view = await getAdminProduct(ctx.db, product.id);
    if (!view) throw badRequest('That product did not archive. Please try again.');
    return ok(toJson(view));
  });
