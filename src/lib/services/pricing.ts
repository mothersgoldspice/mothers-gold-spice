/**
 * Order pricing: line totals, coupons, shipping, COD fee and GST.
 *
 * This module is pure — it takes data and returns numbers, touching neither the
 * database nor the clock — because it is the one place where being wrong costs
 * real money, and pure functions are the only ones worth exhaustively testing.
 * Loading (coupon lookup, serviceability) happens in the callers.
 *
 * GST is INCLUSIVE by default, which is the Indian retail convention and what
 * the label prints: a ₹299 jar contains ₹32.04 of GST at 12%, it does not
 * attract ₹35.88 on top. So `tax_paise` on an order is a breakdown of the total
 * for the invoice, NOT an addition to it. Getting that backwards would overcharge
 * every customer by the tax rate.
 *
 * Services (courier, COD handling) are taxed at 18% rather than the food rate.
 */

import { allocateProportionally, percentOf, taxFromInclusive, taxOnExclusive } from '../money';
import type { CouponRow } from '../db/types';
import type { StoreSettings } from '../settings';
import { weightSlabs, type Zone } from '../shipping-zones';

/** GST on freight and other services. Food is per-variant (12% for pickle). */
export const SERVICE_GST_BPS = 1800;

export interface PricedLineInput {
  variantId: string;
  qty: number;
  unitPricePaise: number;
  gstRateBps: number;
  /** Net product weight, grams — the shipping weight is added by the caller. */
  shippingWeightGrams: number;
}

export interface PricedLine extends PricedLineInput {
  subtotalPaise: number;
  discountPaise: number;
  taxPaise: number;
  totalPaise: number;
}

export interface PricingInput {
  lines: PricedLineInput[];
  settings: StoreSettings;
  /** Null when the customer has not entered a deliverable address yet. */
  zone: Zone | null;
  paymentMethod: 'prepaid' | 'cod';
  coupon: CouponRow | null;
  /** Skip shipping entirely (cart page before an address is known). */
  shippingUnknown?: boolean;
}

export interface PricingResult {
  lines: PricedLine[];
  subtotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  codFeePaise: number;
  taxPaise: number;
  totalPaise: number;
  /** Total billable weight including packaging, grams. */
  weightGrams: number;
  /** True when the order qualified for free shipping. */
  freeShippingApplied: boolean;
  /** Paise still needed to reach free shipping; 0 when already free. */
  freeShippingRemainingPaise: number;
  couponCode: string | null;
  taxInclusive: boolean;
  /** Per-rate GST breakdown for the invoice. */
  taxBreakdown: { rateBps: number; taxablePaise: number; taxPaise: number }[];
}

/**
 * Discount for a coupon against a subtotal. Assumes the coupon has already been
 * validated (see `validateCoupon`) — this only does arithmetic.
 */
export function couponDiscountPaise(coupon: CouponRow, subtotalPaise: number, shippingPaise: number): number {
  switch (coupon.type) {
    case 'percent': {
      // `value` is basis points so 10% is stored as 1000 — a plain "10" would
      // silently become 0.1%.
      const raw = percentOf(subtotalPaise, coupon.value);
      return coupon.max_discount_paise ? Math.min(raw, coupon.max_discount_paise) : raw;
    }
    case 'fixed':
      // Never discount below zero: a ₹200 coupon on a ₹150 basket is ₹150 off.
      return Math.min(coupon.value, subtotalPaise);
    case 'free_shipping':
      return shippingPaise;
    default:
      return 0;
  }
}

/** Customer-facing shipping charge before any free-shipping or coupon relief. */
export function shippingChargePaise(settings: StoreSettings, zone: Zone, weightGrams: number): number {
  const rate = settings.shippingRates[zone];
  const slabs = weightSlabs(weightGrams);
  return rate.first500g + (slabs - 1) * rate.perExtra500g;
}

export function priceOrder(input: PricingInput): PricingResult {
  const { settings, coupon, zone, paymentMethod } = input;

  const lines = input.lines.filter((l) => l.qty > 0);
  const lineSubtotals = lines.map((l) => l.unitPricePaise * l.qty);
  const subtotalPaise = lineSubtotals.reduce((a, b) => a + b, 0);

  const productWeight = lines.reduce((sum, l) => sum + l.shippingWeightGrams * l.qty, 0);
  const weightGrams = productWeight > 0 ? productWeight + settings.packagingWeightGrams : 0;

  // ── Shipping ────────────────────────────────────────────────────────────
  // Computed before the discount so that a free-shipping coupon has something
  // to zero out, and so the "spend ₹X more for free delivery" nudge is honest.
  const baseShipping =
    input.shippingUnknown || zone === null || subtotalPaise === 0 ? 0 : shippingChargePaise(settings, zone, weightGrams);

  // ── Discount ────────────────────────────────────────────────────────────
  const isFreeShippingCoupon = coupon?.type === 'free_shipping';
  const productDiscount = coupon && !isFreeShippingCoupon ? couponDiscountPaise(coupon, subtotalPaise, baseShipping) : 0;

  // The free-shipping threshold is judged on what the customer actually pays for
  // goods — applying it to the pre-discount subtotal would hand out free delivery
  // on a basket that a coupon dropped below the threshold.
  const discountedSubtotal = subtotalPaise - productDiscount;
  const qualifiesFree =
    settings.freeShippingThresholdPaise > 0 && discountedSubtotal >= settings.freeShippingThresholdPaise;

  // The two ways shipping becomes free are represented DIFFERENTLY on purpose,
  // so that `subtotal - discount + shipping + codFee` always equals `total`:
  //
  //   threshold      → shipping is simply 0, with no discount line. The customer
  //                    was never charged for delivery, so inventing a discount to
  //                    cancel a charge that never existed would not add up.
  //   free_shipping  → shipping is charged in full AND an equal discount is
  //   coupon           recorded, so the receipt shows what the coupon was worth.
  //
  // Collapsing both into "shipping = 0, discount = shipping" was the original
  // shape, and it produced invoices where the lines did not sum to the total.
  const shippingPaise = qualifiesFree ? 0 : baseShipping;
  const shippingDiscount = isFreeShippingCoupon && !qualifiesFree ? baseShipping : 0;
  const freeShippingApplied = baseShipping > 0 && (qualifiesFree || shippingDiscount > 0);

  const discountPaise = productDiscount + shippingDiscount;

  const freeShippingRemainingPaise =
    qualifiesFree || settings.freeShippingThresholdPaise <= 0
      ? 0
      : Math.max(0, settings.freeShippingThresholdPaise - discountedSubtotal);

  // ── COD fee ─────────────────────────────────────────────────────────────
  const codFeePaise = paymentMethod === 'cod' && settings.codEnabled && subtotalPaise > 0 ? settings.codFeePaise : 0;

  // ── Per-line allocation ─────────────────────────────────────────────────
  // The product discount is split across lines in proportion to their value so
  // each `order_items` row carries its own share. Without this the line totals
  // would not sum to the order total and every invoice would be off.
  const perLineDiscount = allocateProportionally(productDiscount, lineSubtotals);

  const pricedLines: PricedLine[] = lines.map((line, i) => {
    const lineSubtotal = lineSubtotals[i];
    const lineDiscount = perLineDiscount[i];
    const net = lineSubtotal - lineDiscount;
    const rate = settings.taxEnabled ? (line.gstRateBps || settings.defaultTaxRateBps) : 0;
    const tax = settings.taxInclusive ? taxFromInclusive(net, rate) : taxOnExclusive(net, rate);
    return {
      ...line,
      subtotalPaise: lineSubtotal,
      discountPaise: lineDiscount,
      taxPaise: tax,
      totalPaise: settings.taxInclusive ? net : net + tax,
    };
  });

  // ── Tax ─────────────────────────────────────────────────────────────────
  // GST on services follows what the customer actually pays: a coupon that
  // waives delivery waives the GST on delivery with it.
  const serviceBase = shippingPaise - shippingDiscount + codFeePaise;
  const serviceTax = !settings.taxEnabled
    ? 0
    : settings.taxInclusive
      ? taxFromInclusive(serviceBase, SERVICE_GST_BPS)
      : taxOnExclusive(serviceBase, SERVICE_GST_BPS);

  const productTax = pricedLines.reduce((sum, l) => sum + l.taxPaise, 0);
  const taxPaise = productTax + serviceTax;

  const taxBreakdown = buildTaxBreakdown(pricedLines, serviceBase, serviceTax, settings);

  // ── Total ───────────────────────────────────────────────────────────────
  // Deliberately written as the same arithmetic the receipt shows, so the two
  // cannot drift: subtotal − discount + shipping + COD fee.
  //
  // With inclusive tax the GST already sits inside those prices, so it is NOT
  // added again here. Only the exclusive branch adds it.
  const goodsAndServices = subtotalPaise - discountPaise + shippingPaise + codFeePaise;
  const totalPaise = settings.taxInclusive ? goodsAndServices : goodsAndServices + taxPaise;

  return {
    lines: pricedLines,
    subtotalPaise,
    discountPaise,
    shippingPaise,
    codFeePaise,
    taxPaise,
    totalPaise: Math.max(0, totalPaise),
    weightGrams,
    freeShippingApplied,
    freeShippingRemainingPaise,
    couponCode: coupon?.code ?? null,
    taxInclusive: settings.taxInclusive,
    taxBreakdown,
  };
}

function buildTaxBreakdown(
  lines: PricedLine[],
  serviceBase: number,
  serviceTax: number,
  settings: StoreSettings,
): PricingResult['taxBreakdown'] {
  if (!settings.taxEnabled) return [];

  const byRate = new Map<number, { taxablePaise: number; taxPaise: number }>();
  for (const line of lines) {
    const rate = line.gstRateBps || settings.defaultTaxRateBps;
    const net = line.subtotalPaise - line.discountPaise;
    const taxable = settings.taxInclusive ? net - line.taxPaise : net;
    const entry = byRate.get(rate) ?? { taxablePaise: 0, taxPaise: 0 };
    entry.taxablePaise += taxable;
    entry.taxPaise += line.taxPaise;
    byRate.set(rate, entry);
  }

  if (serviceBase > 0) {
    const taxable = settings.taxInclusive ? serviceBase - serviceTax : serviceBase;
    const entry = byRate.get(SERVICE_GST_BPS) ?? { taxablePaise: 0, taxPaise: 0 };
    entry.taxablePaise += taxable;
    entry.taxPaise += serviceTax;
    byRate.set(SERVICE_GST_BPS, entry);
  }

  return [...byRate]
    .filter(([, v]) => v.taxPaise > 0 || v.taxablePaise > 0)
    .map(([rateBps, v]) => ({ rateBps, ...v }))
    .sort((a, b) => a.rateBps - b.rateBps);
}

// ─── Coupon validation ───────────────────────────────────────────────────────

export interface CouponContext {
  subtotalPaise: number;
  /** Redemptions this identity already has for this coupon. */
  userRedemptions: number;
  /** Whether the customer has any prior paid order. */
  hasPriorOrders: boolean;
  now: number;
}

export type CouponRejection =
  | 'not_found'
  | 'disabled'
  | 'not_started'
  | 'expired'
  | 'usage_limit_reached'
  | 'per_user_limit_reached'
  | 'below_minimum'
  | 'first_order_only';

export interface CouponVerdict {
  valid: boolean;
  reason?: CouponRejection;
  message?: string;
}

/**
 * Pure validation of a coupon against a basket. Every rejection carries a
 * customer-facing message, because "invalid coupon" for a ₹499 minimum that the
 * customer is ₹40 short of is a lost sale.
 */
export function validateCoupon(coupon: CouponRow | null, ctx: CouponContext): CouponVerdict {
  if (!coupon) return { valid: false, reason: 'not_found', message: 'That coupon code is not recognised.' };
  if (coupon.status !== 'active') {
    return { valid: false, reason: 'disabled', message: 'That coupon is no longer available.' };
  }
  if (coupon.starts_at !== null && ctx.now < coupon.starts_at) {
    return { valid: false, reason: 'not_started', message: 'That coupon is not active yet.' };
  }
  if (coupon.ends_at !== null && ctx.now > coupon.ends_at) {
    return { valid: false, reason: 'expired', message: 'That coupon has expired.' };
  }
  if (coupon.usage_limit !== null && coupon.used_count >= coupon.usage_limit) {
    return { valid: false, reason: 'usage_limit_reached', message: 'That coupon has been fully claimed.' };
  }
  if (coupon.per_user_limit > 0 && ctx.userRedemptions >= coupon.per_user_limit) {
    return { valid: false, reason: 'per_user_limit_reached', message: 'You have already used this coupon.' };
  }
  if (coupon.first_order_only === 1 && ctx.hasPriorOrders) {
    return { valid: false, reason: 'first_order_only', message: 'That coupon is for first orders only.' };
  }
  if (ctx.subtotalPaise < coupon.min_subtotal_paise) {
    const short = coupon.min_subtotal_paise - ctx.subtotalPaise;
    return {
      valid: false,
      reason: 'below_minimum',
      message: `Add ₹${Math.ceil(short / 100)} more to use this coupon.`,
    };
  }
  return { valid: true };
}
