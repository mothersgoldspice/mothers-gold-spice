/**
 * Public catalogue. Read-only, anonymous, and deliberately narrow about what it
 * exposes: exact stock counts are an operational detail, so a variant reports
 * `inStock` and a "only a few left" flag rather than "we have 3".
 */

import type { APIRoute } from 'astro';
import { requireCtx } from '../../../lib/api';
import { handle, ok } from '../../../lib/http';
import { listProducts } from '../../../lib/services/catalog';

export const prerender = false;

/** Below this, the storefront says "only a few left" to nudge without lying. */
const LOW_STOCK_SIGNAL = 5;

export const GET: APIRoute = async ({ locals, url }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    const products = await listProducts(ctx.db, { category: url.searchParams.get('category') });

    return ok(
      products.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        subtitle: p.subtitle,
        category: p.category,
        heroImage: p.heroImage,
        images: p.images,
        isVeg: p.isVeg,
        fromPricePaise: p.fromPricePaise,
        anyInStock: p.anyInStock,
        variants: p.variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          name: v.name,
          weightGrams: v.weightGrams,
          pricePaise: v.pricePaise,
          compareAtPricePaise: v.compareAtPricePaise,
          inStock: v.inStock,
          onlyAFewLeft: Number.isFinite(v.available) && v.available > 0 && v.available <= LOW_STOCK_SIGNAL,
        })),
      })),
    );
  });
