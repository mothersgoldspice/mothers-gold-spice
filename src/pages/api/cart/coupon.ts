/**
 * Apply or clear a cart coupon.
 *
 * Applying stores the code and immediately re-reads the cart, so an invalid code
 * comes back as a specific reason ("add ₹40 more") rather than a generic
 * rejection — the difference between a lost sale and a bigger basket.
 */

import type { APIRoute } from 'astro';
import { rateKey, requireCtx } from '../../../lib/api';
import { badRequest } from '../../../lib/errors';
import { handle, ok, readJson } from '../../../lib/http';
import { RATE_LIMITS, enforceRateLimit } from '../../../lib/rate-limit';
import { applyCoupon, getCart, getOrCreateCart, removeCoupon } from '../../../lib/services/cart';
import { couponSchema, parseOrThrow } from '../../../lib/validate';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request, cookies }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    await enforceRateLimit(ctx.db, rateKey(ctx, 'coupon'), RATE_LIMITS.cartWrite);

    const input = parseOrThrow(couponSchema, await readJson(request));
    const settings = await ctx.settings();
    const cartId = await getOrCreateCart(ctx, cookies);

    await applyCoupon(ctx.db, cartId, input.code);
    const cart = await getCart(ctx.db, cartId, settings, { userId: ctx.user?.id ?? null });

    if (cart.couponError) {
      // Do not leave a code attached that will keep failing at checkout.
      await removeCoupon(ctx.db, cartId);
      throw badRequest(cart.couponError);
    }

    return ok({
      applied: true,
      code: cart.couponCode,
      discountPaise: cart.pricing.discountPaise,
      totalPaise: cart.pricing.totalPaise,
    });
  });

export const DELETE: APIRoute = async ({ locals, cookies }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    const cartId = await getOrCreateCart(ctx, cookies);
    await removeCoupon(ctx.db, cartId);
    return ok({ removed: true });
  });
