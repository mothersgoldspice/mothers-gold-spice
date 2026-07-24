/**
 * Order pricing.
 *
 * This is the file that decides what a customer is charged, so every case is
 * asserted as an exact paise figure and the arithmetic is spelled out in the
 * test rather than recomputed from the same helpers the implementation uses —
 * a test that calls `taxFromInclusive` to check `taxFromInclusive` proves only
 * that the function is deterministic.
 *
 * Fixture prices: ₹299 (250 g, 320 g packed) and ₹549 (500 g, 620 g packed),
 * both 12% GST, plus 250 g of packaging on every parcel.
 */

import { describe, expect, it } from 'vitest';

import type { CouponRow } from '../../src/lib/db/types';
import {
  SERVICE_GST_BPS,
  couponDiscountPaise,
  priceOrder,
  shippingChargePaise,
  validateCoupon,
  type PricedLineInput,
} from '../../src/lib/services/pricing';
import { testSettings } from '../setup';

const NOW = 1_784_000_000_000;

const small: PricedLineInput = {
  variantId: 'var_test_250',
  qty: 1,
  unitPricePaise: 29_900,
  gstRateBps: 1200,
  shippingWeightGrams: 320,
};

const large: PricedLineInput = {
  variantId: 'var_test_500',
  qty: 1,
  unitPricePaise: 54_900,
  gstRateBps: 1200,
  shippingWeightGrams: 620,
};

function coupon(patch: Partial<CouponRow> = {}): CouponRow {
  return {
    id: 'cpn_test',
    code: 'TEST10',
    description: '',
    type: 'percent',
    value: 1000,
    min_subtotal_paise: 0,
    max_discount_paise: null,
    starts_at: null,
    ends_at: null,
    usage_limit: null,
    per_user_limit: 1,
    used_count: 0,
    first_order_only: 0,
    status: 'active',
    provider_discount_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...patch,
  };
}

describe('priceOrder — inclusive GST', () => {
  it('contains the tax inside the price instead of adding it on top', () => {
    const result = priceOrder({
      lines: [small],
      settings: testSettings(),
      zone: null,
      paymentMethod: 'prepaid',
      coupon: null,
      shippingUnknown: true,
    });

    expect(result.subtotalPaise).toBe(29_900);
    expect(result.taxPaise).toBe(3204); // ₹32.04 of the ₹299
    expect(result.totalPaise).toBe(29_900);
    // The whole point: the customer pays the MRP, not the MRP plus GST.
    expect(result.totalPaise).not.toBe(result.subtotalPaise + result.taxPaise);
    expect(result.taxInclusive).toBe(true);
    expect(result.lines[0].totalPaise).toBe(29_900);
    expect(result.lines[0].taxPaise).toBe(3204);
  });

  it('reports the taxable value and the tax separately for the invoice', () => {
    const result = priceOrder({
      lines: [small],
      settings: testSettings(),
      zone: null,
      paymentMethod: 'prepaid',
      coupon: null,
      shippingUnknown: true,
    });

    expect(result.taxBreakdown).toEqual([{ rateBps: 1200, taxablePaise: 26_696, taxPaise: 3204 }]);
    expect(result.taxBreakdown[0].taxablePaise + result.taxBreakdown[0].taxPaise).toBe(29_900);
  });

  it('adds the tax on top when the store is configured exclusive', () => {
    const result = priceOrder({
      lines: [small],
      settings: testSettings({ taxInclusive: false }),
      zone: null,
      paymentMethod: 'prepaid',
      coupon: null,
      shippingUnknown: true,
    });

    expect(result.taxPaise).toBe(3588); // 12% ON ₹299
    expect(result.totalPaise).toBe(33_488);
    expect(result.lines[0].totalPaise).toBe(33_488);
  });

  it('charges no tax at all when tax is switched off', () => {
    const result = priceOrder({
      lines: [small],
      settings: testSettings({ taxEnabled: false }),
      zone: null,
      paymentMethod: 'prepaid',
      coupon: null,
      shippingUnknown: true,
    });

    expect(result.taxPaise).toBe(0);
    expect(result.taxBreakdown).toEqual([]);
    expect(result.totalPaise).toBe(29_900);
  });

  it('falls back to the store rate for a variant with none', () => {
    const result = priceOrder({
      lines: [{ ...small, gstRateBps: 0 }],
      settings: testSettings(),
      zone: null,
      paymentMethod: 'prepaid',
      coupon: null,
      shippingUnknown: true,
    });

    expect(result.taxPaise).toBe(3204);
  });
});

describe('priceOrder — shipping', () => {
  it('bills the destination zone by 500 g slabs including packaging', () => {
    // 620 g of jar + 250 g of packaging = 870 g → two slabs.
    const result = priceOrder({
      lines: [large],
      settings: testSettings(),
      zone: 'D',
      paymentMethod: 'prepaid',
      coupon: null,
    });

    expect(result.weightGrams).toBe(870);
    expect(result.shippingPaise).toBe(14_900); // ₹109 first slab + ₹40 second
    expect(shippingChargePaise(testSettings(), 'D', 870)).toBe(14_900);
  });

  it('quotes nothing while the address is still unknown', () => {
    const result = priceOrder({
      lines: [large],
      settings: testSettings(),
      zone: null,
      paymentMethod: 'prepaid',
      coupon: null,
      shippingUnknown: true,
    });

    expect(result.shippingPaise).toBe(0);
    expect(result.freeShippingApplied).toBe(false);
    expect(result.totalPaise).toBe(54_900);
  });

  it('judges the free-shipping threshold AFTER the discount', () => {
    const twoLarge = { ...large, qty: 2 }; // ₹1,098 — over the ₹999 threshold
    const settings = testSettings();

    const undiscounted = priceOrder({
      lines: [twoLarge],
      settings,
      zone: 'D',
      paymentMethod: 'prepaid',
      coupon: null,
    });
    expect(undiscounted.subtotalPaise).toBe(109_800);
    expect(undiscounted.shippingPaise).toBe(0);
    expect(undiscounted.freeShippingApplied).toBe(true);
    expect(undiscounted.freeShippingRemainingPaise).toBe(0);
    expect(undiscounted.totalPaise).toBe(109_800);

    const discounted = priceOrder({
      lines: [twoLarge],
      settings,
      zone: 'D',
      paymentMethod: 'prepaid',
      coupon: coupon({ type: 'percent', value: 2000 }), // 20% → ₹219.60 off
    });
    // ₹1,098 − ₹219.60 = ₹878.40, which is under ₹999, so delivery is charged.
    expect(discounted.discountPaise).toBe(21_960);
    expect(discounted.shippingPaise).toBe(18_900); // 1,490 g → three slabs in zone D
    expect(discounted.freeShippingApplied).toBe(false);
    expect(discounted.freeShippingRemainingPaise).toBe(12_060);
    expect(discounted.totalPaise).toBe(106_740);
  });

  it('never invents a discount line for threshold-based free shipping', () => {
    const result = priceOrder({
      lines: [{ ...large, qty: 2 }],
      settings: testSettings(),
      zone: 'D',
      paymentMethod: 'prepaid',
      coupon: null,
    });

    // Shipping was simply never charged, so recording a discount to cancel it
    // would leave the receipt's lines not summing to its total.
    expect(result.discountPaise).toBe(0);
    expect(result.shippingPaise).toBe(0);
    expect(result.subtotalPaise - result.discountPaise + result.shippingPaise + result.codFeePaise).toBe(
      result.totalPaise,
    );
  });

  it('charges nothing to deliver an empty basket', () => {
    const result = priceOrder({
      lines: [{ ...small, qty: 0 }],
      settings: testSettings(),
      zone: 'E',
      paymentMethod: 'prepaid',
      coupon: null,
    });

    expect(result.shippingPaise).toBe(0);
    expect(result.weightGrams).toBe(0);
  });
});

describe('priceOrder — coupons', () => {
  it('reads a percent coupon as basis points', () => {
    const tenPercent = priceOrder({
      lines: [small],
      settings: testSettings(),
      zone: null,
      paymentMethod: 'prepaid',
      coupon: coupon({ type: 'percent', value: 1000 }),
      shippingUnknown: true,
    });
    expect(tenPercent.discountPaise).toBe(2990);

    // A coupon written as a naive "10" is a tenth of a percent, not a tenth.
    const tenBasisPoints = priceOrder({
      lines: [small],
      settings: testSettings(),
      zone: null,
      paymentMethod: 'prepaid',
      coupon: coupon({ type: 'percent', value: 10 }),
      shippingUnknown: true,
    });
    expect(tenBasisPoints.discountPaise).toBe(30);
  });

  it('caps a percent coupon at its maximum discount', () => {
    const result = priceOrder({
      lines: [{ ...large, qty: 2 }],
      settings: testSettings(),
      zone: null,
      paymentMethod: 'prepaid',
      coupon: coupon({ type: 'percent', value: 5000, max_discount_paise: 20_000 }),
      shippingUnknown: true,
    });

    expect(result.discountPaise).toBe(20_000); // not ₹549
  });

  it('never lets a fixed coupon exceed the subtotal', () => {
    const settings = testSettings();
    expect(couponDiscountPaise(coupon({ type: 'fixed', value: 50_000 }), 29_900, 0)).toBe(29_900);

    const result = priceOrder({
      lines: [small],
      settings,
      zone: 'D',
      paymentMethod: 'prepaid',
      coupon: coupon({ type: 'fixed', value: 50_000 }),
    });

    // Goods go to zero, delivery is still owed — the total never goes negative.
    expect(result.discountPaise).toBe(29_900);
    expect(result.shippingPaise).toBe(14_900);
    expect(result.totalPaise).toBe(14_900);
    expect(result.totalPaise).toBeGreaterThanOrEqual(0);
  });

  it('records a free_shipping coupon as a discount worth the delivery charge', () => {
    const result = priceOrder({
      lines: [small],
      settings: testSettings(),
      zone: 'D',
      paymentMethod: 'prepaid',
      coupon: coupon({ type: 'free_shipping', value: 0 }),
    });

    // Charged in full AND discounted in full, so the receipt shows what the
    // coupon was worth and the lines still sum to the total.
    expect(result.shippingPaise).toBe(14_900);
    expect(result.discountPaise).toBe(14_900);
    expect(result.freeShippingApplied).toBe(true);
    expect(result.totalPaise).toBe(29_900);
    // Waiving the delivery waives the GST on the delivery with it.
    expect(result.taxPaise).toBe(3204);
  });

  it('does not double up when a free_shipping coupon meets a qualifying basket', () => {
    const result = priceOrder({
      lines: [{ ...large, qty: 2 }],
      settings: testSettings(),
      zone: 'D',
      paymentMethod: 'prepaid',
      coupon: coupon({ type: 'free_shipping', value: 0 }),
    });

    expect(result.shippingPaise).toBe(0);
    expect(result.discountPaise).toBe(0);
    expect(result.totalPaise).toBe(109_800);
  });

  it('carries the coupon code onto the result', () => {
    const result = priceOrder({
      lines: [small],
      settings: testSettings(),
      zone: null,
      paymentMethod: 'prepaid',
      coupon: coupon({ code: 'FIRST10' }),
      shippingUnknown: true,
    });

    expect(result.couponCode).toBe('FIRST10');
  });
});

describe('priceOrder — cash on delivery', () => {
  it('adds the handling fee and taxes it as a service', () => {
    const result = priceOrder({
      lines: [small],
      settings: testSettings(),
      zone: 'A',
      paymentMethod: 'cod',
      coupon: null,
    });

    expect(result.shippingPaise).toBe(7400); // 570 g → two slabs in Bengaluru
    expect(result.codFeePaise).toBe(4000);
    expect(result.totalPaise).toBe(41_300);
    // ₹114 of services at 18% inclusive is ₹17.39; the jar contributes ₹32.04.
    expect(result.taxPaise).toBe(3204 + 1739);
    expect(result.taxBreakdown).toEqual([
      { rateBps: 1200, taxablePaise: 26_696, taxPaise: 3204 },
      { rateBps: SERVICE_GST_BPS, taxablePaise: 9661, taxPaise: 1739 },
    ]);
  });

  it('charges no fee when cash on delivery is switched off', () => {
    const result = priceOrder({
      lines: [small],
      settings: testSettings({ codEnabled: false }),
      zone: 'A',
      paymentMethod: 'cod',
      coupon: null,
    });

    expect(result.codFeePaise).toBe(0);
  });

  it('charges no fee on an empty basket', () => {
    const result = priceOrder({
      lines: [],
      settings: testSettings(),
      zone: 'A',
      paymentMethod: 'cod',
      coupon: null,
    });

    expect(result.codFeePaise).toBe(0);
  });
});

describe('priceOrder — per-line allocation', () => {
  const basket: PricedLineInput[] = [
    { ...small, qty: 1 }, // ₹299
    { ...large, qty: 2 }, // ₹1,098
    {
      variantId: 'var_test_chut',
      qty: 3,
      unitPricePaise: 24_900,
      gstRateBps: 1200,
      shippingWeightGrams: 260,
    }, // ₹747
  ];

  it('splits the discount across lines so the parts sum to the order discount', () => {
    const result = priceOrder({
      lines: basket,
      settings: testSettings(),
      zone: null,
      paymentMethod: 'prepaid',
      coupon: coupon({ type: 'percent', value: 777 }), // deliberately awkward
      shippingUnknown: true,
    });

    expect(result.subtotalPaise).toBe(214_400);
    expect(result.discountPaise).toBe(16_659); // 7.77% of ₹2,144

    const perLine = result.lines.map((l) => l.discountPaise);
    expect(perLine.reduce((a, b) => a + b, 0)).toBe(result.discountPaise);
    // Flooring the three shares leaves 2 paise over; they land on the two
    // largest lines, never on the first line by default.
    expect(perLine).toEqual([2323, 8532, 5804]);
  });

  it('keeps every line total consistent with the order total', () => {
    const result = priceOrder({
      lines: basket,
      settings: testSettings(),
      zone: 'C',
      paymentMethod: 'cod',
      coupon: coupon({ type: 'percent', value: 1500 }),
    });

    const lineTotals = result.lines.reduce((sum, l) => sum + l.totalPaise, 0);
    expect(lineTotals).toBe(result.subtotalPaise - result.discountPaise);
    expect(result.totalPaise).toBe(lineTotals + result.shippingPaise + result.codFeePaise);
  });

  it('taxes each line on its value after its share of the discount', () => {
    const result = priceOrder({
      lines: basket,
      settings: testSettings(),
      zone: null,
      paymentMethod: 'prepaid',
      coupon: coupon({ type: 'percent', value: 1000 }),
      shippingUnknown: true,
    });

    for (const line of result.lines) {
      const net = line.subtotalPaise - line.discountPaise;
      expect(line.totalPaise).toBe(net);
      expect(line.taxPaise).toBe(Math.round((net * 1200) / 11_200));
    }
  });

  it('drops zero-quantity lines entirely', () => {
    const result = priceOrder({
      lines: [{ ...small, qty: 0 }, { ...large, qty: 1 }],
      settings: testSettings(),
      zone: null,
      paymentMethod: 'prepaid',
      coupon: null,
      shippingUnknown: true,
    });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].variantId).toBe('var_test_500');
  });
});

describe('priceOrder — empty cart', () => {
  it('prices nothing as nothing', () => {
    const result = priceOrder({
      lines: [],
      settings: testSettings(),
      zone: 'D',
      paymentMethod: 'prepaid',
      coupon: null,
    });

    expect(result).toMatchObject({
      subtotalPaise: 0,
      discountPaise: 0,
      shippingPaise: 0,
      codFeePaise: 0,
      taxPaise: 0,
      totalPaise: 0,
      weightGrams: 0,
      freeShippingApplied: false,
      couponCode: null,
    });
    expect(result.lines).toEqual([]);
    expect(result.taxBreakdown).toEqual([]);
  });

  it('does not hand out a discount on an empty cart', () => {
    const result = priceOrder({
      lines: [],
      settings: testSettings(),
      zone: 'D',
      paymentMethod: 'prepaid',
      coupon: coupon({ type: 'fixed', value: 50_000 }),
    });

    expect(result.discountPaise).toBe(0);
    expect(result.totalPaise).toBe(0);
  });
});

describe('validateCoupon', () => {
  const ctx = { subtotalPaise: 50_000, userRedemptions: 0, hasPriorOrders: false, now: NOW };

  it('accepts a coupon that clears every gate', () => {
    expect(validateCoupon(coupon(), ctx)).toEqual({ valid: true });
  });

  it('rejects a code that does not exist', () => {
    const verdict = validateCoupon(null, ctx);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe('not_found');
    expect(verdict.message).toBeTruthy();
  });

  it('rejects a disabled coupon', () => {
    expect(validateCoupon(coupon({ status: 'disabled' }), ctx).reason).toBe('disabled');
  });

  it('rejects a coupon whose window has not opened', () => {
    expect(validateCoupon(coupon({ starts_at: NOW + 1000 }), ctx).reason).toBe('not_started');
    // The boundary itself is open.
    expect(validateCoupon(coupon({ starts_at: NOW }), ctx).valid).toBe(true);
  });

  it('rejects an expired coupon', () => {
    expect(validateCoupon(coupon({ ends_at: NOW - 1 }), ctx).reason).toBe('expired');
    expect(validateCoupon(coupon({ ends_at: NOW }), ctx).valid).toBe(true);
  });

  it('rejects a coupon that has been fully claimed', () => {
    expect(validateCoupon(coupon({ usage_limit: 100, used_count: 100 }), ctx).reason).toBe('usage_limit_reached');
    expect(validateCoupon(coupon({ usage_limit: 100, used_count: 99 }), ctx).valid).toBe(true);
    // No limit means no ceiling, however many have gone out.
    expect(validateCoupon(coupon({ usage_limit: null, used_count: 9999 }), ctx).valid).toBe(true);
  });

  it('rejects a customer who has already used it', () => {
    const verdict = validateCoupon(coupon({ per_user_limit: 1 }), { ...ctx, userRedemptions: 1 });
    expect(verdict.reason).toBe('per_user_limit_reached');
    expect(validateCoupon(coupon({ per_user_limit: 2 }), { ...ctx, userRedemptions: 1 }).valid).toBe(true);
    // A zero limit means unlimited, not "never".
    expect(validateCoupon(coupon({ per_user_limit: 0 }), { ...ctx, userRedemptions: 9 }).valid).toBe(true);
  });

  it('rejects a first-order coupon for a returning customer', () => {
    expect(validateCoupon(coupon({ first_order_only: 1 }), { ...ctx, hasPriorOrders: true }).reason).toBe(
      'first_order_only',
    );
    expect(validateCoupon(coupon({ first_order_only: 1 }), { ...ctx, hasPriorOrders: false }).valid).toBe(true);
  });

  it('rejects a basket under the minimum, and says how much more is needed', () => {
    const verdict = validateCoupon(coupon({ min_subtotal_paise: 99_900 }), { ...ctx, subtotalPaise: 95_900 });
    expect(verdict.reason).toBe('below_minimum');
    // ₹959 needs ₹40 more to reach ₹999 — a lost sale if we just said "invalid".
    expect(verdict.message).toBe('Add ₹40 more to use this coupon.');
    expect(validateCoupon(coupon({ min_subtotal_paise: 99_900 }), { ...ctx, subtotalPaise: 99_900 }).valid).toBe(true);
  });

  it('reports the earliest failure when several apply', () => {
    // Status is checked before the window, which is checked before the minimum.
    const verdict = validateCoupon(
      coupon({ status: 'disabled', ends_at: NOW - 1, min_subtotal_paise: 999_999 }),
      ctx,
    );
    expect(verdict.reason).toBe('disabled');
  });
});
