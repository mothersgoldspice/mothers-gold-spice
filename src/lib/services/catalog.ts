/**
 * Catalog reads.
 *
 * Services own their SQL here rather than sitting behind a repository layer.
 * For a store this size the indirection buys nothing: the queries are few,
 * they are all shaped by the view that consumes them, and keeping them next to
 * the logic makes an N+1 obvious instead of hiding it behind a method name.
 */

import type { Db } from '../db/client';
import { parseJson } from '../db/client';
import type { InventoryRow, ProductRow, VariantRow } from '../db/types';
import { notFound } from '../errors';

export interface VariantView {
  id: string;
  productId: string;
  sku: string;
  name: string;
  weightGrams: number;
  shippingWeightGrams: number;
  pricePaise: number;
  compareAtPricePaise: number | null;
  hsnCode: string;
  gstRateBps: number;
  /** on_hand - reserved, or Infinity when the variant is not stock-tracked. */
  available: number;
  inStock: boolean;
  lowStock: boolean;
}

export interface ProductView {
  id: string;
  slug: string;
  name: string;
  subtitle: string;
  description: string;
  category: string;
  status: ProductRow['status'];
  heroImage: string | null;
  images: string[];
  ingredients: string;
  allergens: string;
  shelfLifeMonths: number | null;
  storageNote: string;
  isVeg: boolean;
  variants: VariantView[];
  /** Cheapest active variant price, for listing cards. */
  fromPricePaise: number | null;
  anyInStock: boolean;
}

function toVariantView(v: VariantRow, inv: InventoryRow | undefined): VariantView {
  const tracked = inv ? inv.track === 1 : false;
  const available = tracked ? Math.max(0, inv!.on_hand - inv!.reserved) : Number.POSITIVE_INFINITY;
  return {
    id: v.id,
    productId: v.product_id,
    sku: v.sku,
    name: v.name,
    weightGrams: v.weight_grams,
    shippingWeightGrams: v.shipping_weight_grams,
    pricePaise: v.price_paise,
    compareAtPricePaise: v.compare_at_price_paise,
    hsnCode: v.hsn_code,
    gstRateBps: v.gst_rate_bps,
    available,
    inStock: available > 0,
    lowStock: tracked && available > 0 && available <= (inv?.reorder_level ?? 0),
  };
}

function toProductView(p: ProductRow, variants: VariantView[]): ProductView {
  const sellable = variants.filter((v) => v.inStock);
  const prices = variants.map((v) => v.pricePaise);
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    subtitle: p.subtitle,
    description: p.description,
    category: p.category,
    status: p.status,
    heroImage: p.hero_image,
    images: parseJson<string[]>(p.images_json, []),
    ingredients: p.ingredients,
    allergens: p.allergens,
    shelfLifeMonths: p.shelf_life_months,
    storageNote: p.storage_note,
    isVeg: p.is_veg === 1,
    variants,
    fromPricePaise: prices.length > 0 ? Math.min(...prices) : null,
    anyInStock: sellable.length > 0,
  };
}

/**
 * All products for the storefront, with variants and stock.
 *
 * Three queries total regardless of catalogue size — products, then every
 * variant, then every inventory row — assembled in memory. A per-product
 * variant query would be an N+1 on the busiest page on the site.
 */
export async function listProducts(
  db: Db,
  opts: { includeInactive?: boolean; category?: string | null } = {},
): Promise<ProductView[]> {
  const statusClause = opts.includeInactive ? '' : "WHERE status = 'active'";
  const params: string[] = [];
  let where = statusClause;
  if (opts.category) {
    where = statusClause ? `${statusClause} AND category = ?` : 'WHERE category = ?';
    params.push(opts.category);
  }

  const products = await db.all<ProductRow>(
    `SELECT * FROM products ${where} ORDER BY sort_order, created_at`,
    params,
  );
  if (products.length === 0) return [];

  const variants = await db.all<VariantRow>(
    "SELECT * FROM product_variants WHERE status = 'active' ORDER BY sort_order, price_paise",
  );
  const inventory = await db.all<InventoryRow>('SELECT * FROM inventory');
  const invByVariant = new Map(inventory.map((i) => [i.variant_id, i]));

  const variantsByProduct = new Map<string, VariantView[]>();
  for (const v of variants) {
    const list = variantsByProduct.get(v.product_id) ?? [];
    list.push(toVariantView(v, invByVariant.get(v.id)));
    variantsByProduct.set(v.product_id, list);
  }

  return products.map((p) => toProductView(p, variantsByProduct.get(p.id) ?? []));
}

export async function getProductBySlug(db: Db, slug: string, includeInactive = false): Promise<ProductView | null> {
  const product = await db.first<ProductRow>(
    includeInactive
      ? 'SELECT * FROM products WHERE slug = ?'
      : "SELECT * FROM products WHERE slug = ? AND status = 'active'",
    [slug],
  );
  if (!product) return null;

  const variants = await db.all<VariantRow>(
    "SELECT * FROM product_variants WHERE product_id = ? AND status = 'active' ORDER BY sort_order, price_paise",
    [product.id],
  );
  const inventory = await db.all<InventoryRow>(
    `SELECT i.* FROM inventory i JOIN product_variants v ON v.id = i.variant_id WHERE v.product_id = ?`,
    [product.id],
  );
  const invByVariant = new Map(inventory.map((i) => [i.variant_id, i]));

  return toProductView(
    product,
    variants.map((v) => toVariantView(v, invByVariant.get(v.id))),
  );
}

/** A variant plus enough of its product to render a cart line. */
export interface SellableVariant extends VariantView {
  productName: string;
  productSlug: string;
  productImage: string | null;
  productStatus: ProductRow['status'];
}

export async function getSellableVariants(db: Db, variantIds: string[]): Promise<Map<string, SellableVariant>> {
  if (variantIds.length === 0) return new Map();

  const placeholders = variantIds.map(() => '?').join(', ');
  const rows = await db.all<
    VariantRow & {
      product_name: string;
      product_slug: string;
      product_image: string | null;
      product_status: ProductRow['status'];
      on_hand: number | null;
      reserved: number | null;
      reorder_level: number | null;
      track: number | null;
    }
  >(
    `SELECT v.*,
            p.name   AS product_name,
            p.slug   AS product_slug,
            p.hero_image AS product_image,
            p.status AS product_status,
            i.on_hand, i.reserved, i.reorder_level, i.track
       FROM product_variants v
       JOIN products  p ON p.id = v.product_id
       LEFT JOIN inventory i ON i.variant_id = v.id
      WHERE v.id IN (${placeholders})`,
    variantIds,
  );

  const out = new Map<string, SellableVariant>();
  for (const row of rows) {
    const inv: InventoryRow | undefined =
      row.on_hand === null
        ? undefined
        : {
            variant_id: row.id,
            on_hand: row.on_hand,
            reserved: row.reserved ?? 0,
            reorder_level: row.reorder_level ?? 0,
            track: row.track ?? 1,
            updated_at: 0,
          };
    out.set(row.id, {
      ...toVariantView(row, inv),
      productName: row.product_name,
      productSlug: row.product_slug,
      productImage: row.product_image,
      productStatus: row.product_status,
    });
  }
  return out;
}

export async function getSellableVariant(db: Db, variantId: string): Promise<SellableVariant> {
  const found = (await getSellableVariants(db, [variantId])).get(variantId);
  if (!found) throw notFound('That item is no longer available.');
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin catalogue
//
// The storefront views above hide archived rows and blur stock on purpose. The
// console needs the opposite — every status, exact counts — so it gets its own
// views rather than a flag threaded through the ones customers see.
//
// They are built on `toVariantView` rather than beside it, which is the point:
// "does this render as sold out on /shop" has to be answered by the same code
// that decides it on /shop, or the console will reassure an operator about a
// product the shop is quietly refusing to sell.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdminVariantView extends VariantView {
  status: VariantRow['status'];
  sortOrder: number;
  /** Exact shelf counts. `tracked` is false when no inventory row exists at all. */
  onHand: number;
  reserved: number;
  reorderLevel: number;
  tracked: boolean;
  /** Rows in order_items pointing here. Only ever grows — see the archive rule. */
  orderLineCount: number;
  /** Active AND buyable right now. This is what the shop keys "sold out" off. */
  sellable: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AdminProductView {
  id: string;
  slug: string;
  name: string;
  subtitle: string;
  description: string;
  category: string;
  status: ProductRow['status'];
  heroImage: string | null;
  images: string[];
  ingredients: string;
  allergens: string;
  shelfLifeMonths: number | null;
  storageNote: string;
  isVeg: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  /** Every variant, archived ones included, in the order the editor shows them. */
  variants: AdminVariantView[];
  activeVariantCount: number;
  /** Cheapest and dearest ACTIVE variant — an archived price is not on sale. */
  minPricePaise: number | null;
  maxPricePaise: number | null;
  /** on_hand summed over active variants; archived jars are not sellable stock. */
  totalOnHand: number;
  orderLineCount: number;
  /**
   * Live on /shop with nothing buyable on it — a card that is permanently sold
   * out. Almost always a mistake (variants archived, or stock never counted in),
   * and invisible from the shop side because the page renders perfectly.
   */
  showsAsSoldOut: boolean;
}

/** One row of `GROUP BY product_id, variant_id` over order_items. */
interface OrderLineCountRow {
  product_id: string;
  variant_id: string;
  n: number;
}

function toAdminVariantView(v: VariantRow, inv: InventoryRow | undefined, orderLineCount: number): AdminVariantView {
  const base = toVariantView(v, inv);
  const tracked = inv ? inv.track === 1 : false;
  return {
    ...base,
    status: v.status,
    sortOrder: v.sort_order,
    onHand: inv?.on_hand ?? 0,
    reserved: inv?.reserved ?? 0,
    reorderLevel: inv?.reorder_level ?? 0,
    tracked,
    orderLineCount,
    // `inStock` already accounts for untracked variants reading as infinite.
    sellable: v.status === 'active' && base.inStock,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
  };
}

function toAdminProductView(
  p: ProductRow,
  variants: VariantRow[],
  invByVariant: Map<string, InventoryRow>,
  countsByVariant: Map<string, number>,
  orderLineCount: number,
): AdminProductView {
  const views = variants.map((v) => toAdminVariantView(v, invByVariant.get(v.id), countsByVariant.get(v.id) ?? 0));
  const active = views.filter((v) => v.status === 'active');
  const prices = active.map((v) => v.pricePaise);

  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    subtitle: p.subtitle,
    description: p.description,
    category: p.category,
    status: p.status,
    heroImage: p.hero_image,
    images: parseJson<string[]>(p.images_json, []),
    ingredients: p.ingredients,
    allergens: p.allergens,
    shelfLifeMonths: p.shelf_life_months,
    storageNote: p.storage_note,
    isVeg: p.is_veg === 1,
    sortOrder: p.sort_order,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    variants: views,
    activeVariantCount: active.length,
    minPricePaise: prices.length > 0 ? Math.min(...prices) : null,
    maxPricePaise: prices.length > 0 ? Math.max(...prices) : null,
    totalOnHand: active.reduce((sum, v) => sum + v.onHand, 0),
    orderLineCount,
    showsAsSoldOut: p.status === 'active' && !views.some((v) => v.sellable),
  };
}

/**
 * The whole catalogue for the console: every product, every status, with stock
 * and how many order lines already reference each row.
 *
 * Four reads regardless of catalogue size. The order counts come from one
 * `GROUP BY` over order_items rather than a correlated subquery per product —
 * order_items carries an index on order_id only, so a per-product COUNT would
 * rescan the entire table once per row in the list.
 */
export async function listAdminCatalogue(db: Db): Promise<AdminProductView[]> {
  const [products, variants, inventory, counts] = await Promise.all([
    db.all<ProductRow>('SELECT * FROM products ORDER BY sort_order, name COLLATE NOCASE'),
    db.all<VariantRow>('SELECT * FROM product_variants ORDER BY sort_order, price_paise'),
    db.all<InventoryRow>('SELECT * FROM inventory'),
    db.all<OrderLineCountRow>(
      'SELECT product_id, variant_id, COUNT(*) AS n FROM order_items GROUP BY product_id, variant_id',
    ),
  ]);
  if (products.length === 0) return [];

  const invByVariant = new Map(inventory.map((i) => [i.variant_id, i]));
  const countsByVariant = new Map(counts.map((c) => [c.variant_id, c.n]));

  const countsByProduct = new Map<string, number>();
  for (const c of counts) countsByProduct.set(c.product_id, (countsByProduct.get(c.product_id) ?? 0) + c.n);

  const variantsByProduct = new Map<string, VariantRow[]>();
  for (const v of variants) {
    const list = variantsByProduct.get(v.product_id) ?? [];
    list.push(v);
    variantsByProduct.set(v.product_id, list);
  }

  return products.map((p) =>
    toAdminProductView(
      p,
      variantsByProduct.get(p.id) ?? [],
      invByVariant,
      countsByVariant,
      countsByProduct.get(p.id) ?? 0,
    ),
  );
}

/** One product for the editor, in the same shape as the list. */
export async function getAdminProduct(db: Db, productId: string): Promise<AdminProductView | null> {
  const product = await db.first<ProductRow>('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) return null;

  const [variants, inventory, counts] = await Promise.all([
    db.all<VariantRow>('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order, price_paise', [
      productId,
    ]),
    db.all<InventoryRow>(
      'SELECT i.* FROM inventory i JOIN product_variants v ON v.id = i.variant_id WHERE v.product_id = ?',
      [productId],
    ),
    db.all<OrderLineCountRow>(
      'SELECT product_id, variant_id, COUNT(*) AS n FROM order_items WHERE product_id = ? GROUP BY product_id, variant_id',
      [productId],
    ),
  ]);

  return toAdminProductView(
    product,
    variants,
    new Map(inventory.map((i) => [i.variant_id, i])),
    new Map(counts.map((c) => [c.variant_id, c.n])),
    counts.reduce((sum, c) => sum + c.n, 0),
  );
}

/**
 * Categories already in use, for the editor's suggestion list.
 *
 * Read from the data rather than kept as a constant on purpose: the brand grows
 * into chutneys, cookies and whatever comes next, and a hard-coded enum would
 * mean a deploy every time somebody names a new shelf.
 */
export async function listCategories(db: Db): Promise<string[]> {
  const rows = await db.all<{ category: string }>(
    'SELECT DISTINCT category FROM products ORDER BY category COLLATE NOCASE',
  );
  return rows.map((r) => r.category);
}
