/**
 * The cart: read it, mutate it.
 *
 * All four verbs return the FULL recomputed cart rather than an acknowledgement,
 * so the client never has to reconstruct totals locally — the only place cart
 * money is calculated is the pricing module on the server.
 */

import type { APIRoute } from 'astro';
import { rateKey, requireCtx } from '../../../lib/api';
import { handle, ok, readJson } from '../../../lib/http';
import { RATE_LIMITS, enforceRateLimit } from '../../../lib/rate-limit';
import { addItem, getCart, getOrCreateCart, removeItem, updateItem } from '../../../lib/services/cart';
import { zoneForPincode, isValidPincode } from '../../../lib/shipping-zones';
import { cartAddSchema, cartUpdateSchema, parseOrThrow } from '../../../lib/validate';

export const prerender = false;

/**
 * Serialise a cart for the browser. The `variant` object is trimmed to what the
 * UI renders — sending the whole row would leak internal stock counts on a
 * public endpoint.
 */
async function cartResponse(
  ctx: ReturnType<typeof requireCtx>,
  cartId: string | null,
  pincode: string | null,
  paymentMethod: 'prepaid' | 'cod',
) {
  const settings = await ctx.settings();
  const zone = pincode && isValidPincode(pincode) ? zoneForPincode(pincode) : null;
  const cart = await getCart(ctx.db, cartId, settings, { zone, paymentMethod, userId: ctx.user?.id ?? null });

  return {
    id: cart.id,
    itemCount: cart.itemCount,
    couponCode: cart.couponCode,
    couponError: cart.couponError,
    hasIssues: cart.hasIssues,
    lines: cart.lines.map((line) => ({
      variantId: line.variantId,
      qty: line.qty,
      unitPricePaise: line.unitPricePaise,
      lineTotalPaise: line.lineTotalPaise,
      priceChanged: line.priceChanged,
      availabilityIssue: line.availabilityIssue,
      productName: line.variant.productName,
      productSlug: line.variant.productSlug,
      variantName: line.variant.name,
      image: line.variant.productImage,
      sku: line.variant.sku,
    })),
    totals: {
      subtotalPaise: cart.pricing.subtotalPaise,
      discountPaise: cart.pricing.discountPaise,
      shippingPaise: cart.pricing.shippingPaise,
      codFeePaise: cart.pricing.codFeePaise,
      taxPaise: cart.pricing.taxPaise,
      totalPaise: cart.pricing.totalPaise,
      taxInclusive: cart.pricing.taxInclusive,
      freeShippingApplied: cart.pricing.freeShippingApplied,
      freeShippingRemainingPaise: cart.pricing.freeShippingRemainingPaise,
      weightGrams: cart.pricing.weightGrams,
    },
  };
}

export const GET: APIRoute = async ({ locals, url }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    const paymentMethod = url.searchParams.get('payment_method') === 'cod' ? 'cod' : 'prepaid';
    return ok(await cartResponse(ctx, ctx.cartId, url.searchParams.get('pincode'), paymentMethod));
  });

export const POST: APIRoute = async ({ locals, request, cookies, url }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    await enforceRateLimit(ctx.db, rateKey(ctx, 'cart'), RATE_LIMITS.cartWrite);

    const input = parseOrThrow(cartAddSchema, await readJson(request));
    const settings = await ctx.settings();
    const cartId = await getOrCreateCart(ctx, cookies);

    await addItem(ctx.db, cartId, input.variant_id, input.qty, settings);
    return ok(await cartResponse(ctx, cartId, url.searchParams.get('pincode'), 'prepaid'));
  });

export const PATCH: APIRoute = async ({ locals, request, cookies, url }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    await enforceRateLimit(ctx.db, rateKey(ctx, 'cart'), RATE_LIMITS.cartWrite);

    const input = parseOrThrow(cartUpdateSchema, await readJson(request));
    const settings = await ctx.settings();
    const cartId = await getOrCreateCart(ctx, cookies);

    await updateItem(ctx.db, cartId, input.variant_id, input.qty, settings);
    return ok(await cartResponse(ctx, cartId, url.searchParams.get('pincode'), 'prepaid'));
  });

export const DELETE: APIRoute = async ({ locals, request, cookies, url }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    await enforceRateLimit(ctx.db, rateKey(ctx, 'cart'), RATE_LIMITS.cartWrite);

    const body = await readJson<{ variant_id?: string }>(request);
    const cartId = await getOrCreateCart(ctx, cookies);
    if (body.variant_id) await removeItem(ctx.db, cartId, body.variant_id);

    return ok(await cartResponse(ctx, cartId, url.searchParams.get('pincode'), 'prepaid'));
  });
