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
