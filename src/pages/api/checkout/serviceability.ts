/**
 * "Do you deliver to my PIN code?" — answered before the customer fills in an
 * address, because finding out after typing everything is how carts get
 * abandoned.
 *
 * Returns the customer-facing shipping charge too, so the delivery estimate and
 * the price update together.
 */

import type { APIRoute } from 'astro';
import { rateKey, requireCtx } from '../../../lib/api';
import { handle, ok, readJson } from '../../../lib/http';
import { RATE_LIMITS, enforceRateLimit } from '../../../lib/rate-limit';
import { getCart } from '../../../lib/services/cart';
import { shippingChargePaise } from '../../../lib/services/pricing';
import { checkServiceability } from '../../../lib/services/shipments';
import { ZONE_ETD_DAYS, ZONE_LABEL, zoneForPincode } from '../../../lib/shipping-zones';
import { parseOrThrow, serviceabilitySchema } from '../../../lib/validate';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    await enforceRateLimit(ctx.db, rateKey(ctx, 'pincode'), RATE_LIMITS.pincodeLookup);

    const input = parseOrThrow(serviceabilitySchema, await readJson(request));
    const settings = await ctx.settings();
    const zone = zoneForPincode(input.pincode);

    const cart = await getCart(ctx.db, ctx.cartId, settings, {
      zone,
      paymentMethod: input.cod ? 'cod' : 'prepaid',
      userId: ctx.user?.id ?? null,
    });

    const result = await checkServiceability(ctx, input.pincode, {
      weightGrams: cart.pricing.weightGrams || settings.packagingWeightGrams,
      declaredValuePaise: cart.pricing.subtotalPaise,
      cod: input.cod,
    });

    const rawShipping = shippingChargePaise(settings, zone, cart.pricing.weightGrams || 500);

    return ok({
      pincode: input.pincode,
      serviceable: result.serviceable,
      codAvailable: result.codAvailable && settings.codEnabled,
      zone,
      zoneLabel: ZONE_LABEL[zone],
      estimatedDays: result.quotes[0]?.estimatedDays ?? ZONE_ETD_DAYS[zone],
      city: result.city,
      state: result.state,
      shippingPaise: cart.pricing.shippingPaise,
      // Shown struck through when free shipping kicked in, so the customer can
      // see what the delivery would otherwise have cost.
      shippingBeforeDiscountPaise: rawShipping,
      freeShippingApplied: cart.pricing.freeShippingApplied,
      freeShippingRemainingPaise: cart.pricing.freeShippingRemainingPaise,
      totalPaise: cart.pricing.totalPaise,
      codFeePaise: cart.pricing.codFeePaise,
    });
  });
