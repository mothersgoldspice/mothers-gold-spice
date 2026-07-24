/**
 * Money arithmetic.
 *
 * Everything here is integer paise, and every assertion is written as the exact
 * integer rather than a rounded rupee figure — a test that accepts "about ₹32"
 * cannot catch the drift it exists to prevent.
 */

import { describe, expect, it } from 'vitest';

import {
  allocateProportionally,
  formatPaise,
  groupIndian,
  paiseToDecimalString,
  paiseToRupees,
  percentOf,
  rupeesToPaise,
  taxFromInclusive,
  taxOnExclusive,
} from '../../src/lib/money';
import { seededRandom } from '../setup';

describe('formatPaise', () => {
  it('drops the decimals on a whole-rupee amount', () => {
    expect(formatPaise(44900)).toBe('₹449');
    expect(formatPaise(0)).toBe('₹0');
  });

  it('shows paise when there are any', () => {
    expect(formatPaise(44950)).toBe('₹449.50');
    expect(formatPaise(3204)).toBe('₹32.04');
    expect(formatPaise(1)).toBe('₹0.01');
  });

  it('groups in the Indian style', () => {
    expect(formatPaise(123456700)).toBe('₹12,34,567');
  });

  it('carries the sign outside the symbol', () => {
    expect(formatPaise(-44950)).toBe('-₹449.50');
    expect(formatPaise(-44900)).toBe('-₹449');
  });

  it('honours withSymbol and forceDecimals', () => {
    expect(formatPaise(44900, { withSymbol: false })).toBe('449');
    expect(formatPaise(44900, { forceDecimals: true })).toBe('₹449.00');
    expect(formatPaise(44950, { withSymbol: false, forceDecimals: true })).toBe('449.50');
  });
});

describe('groupIndian', () => {
  it('leaves three digits or fewer alone', () => {
    expect(groupIndian(0)).toBe('0');
    expect(groupIndian(9)).toBe('9');
    expect(groupIndian(999)).toBe('999');
  });

  it('groups the last three, then in pairs', () => {
    expect(groupIndian(1000)).toBe('1,000');
    expect(groupIndian(99999)).toBe('99,999');
    expect(groupIndian(100000)).toBe('1,00,000');
    expect(groupIndian(1234567)).toBe('12,34,567');
    expect(groupIndian(123456789)).toBe('12,34,56,789');
  });
});

describe('taxFromInclusive', () => {
  it('finds the 12% GST already inside a ₹299 MRP', () => {
    // ₹299 contains ₹32.04 of GST; it does not attract ₹35.88 on top.
    expect(taxFromInclusive(29900, 1200)).toBe(3204);
    expect(formatPaise(taxFromInclusive(29900, 1200))).toBe('₹32.04');
  });

  it('is strictly less than the same rate applied on top', () => {
    expect(taxFromInclusive(29900, 1200)).toBeLessThan(taxOnExclusive(29900, 1200));
    expect(taxOnExclusive(29900, 1200)).toBe(3588);
  });

  it('leaves a taxable base the same rate would tax back to the same paisa', () => {
    // The invoice prints the taxable value and the tax separately, so the two
    // have to agree: taxing the base at 12% must reproduce the tax taken out.
    for (const gross of [29900, 54900, 24900, 99900, 109800, 1, 7]) {
      const tax = taxFromInclusive(gross, 1200);
      expect(Number.isInteger(tax)).toBe(true);
      expect(tax).toBeLessThan(gross === 0 ? 1 : gross);
      expect(Math.abs(taxOnExclusive(gross - tax, 1200) - tax)).toBeLessThanOrEqual(1);
    }
  });

  it('is zero for a zero or non-positive rate', () => {
    expect(taxFromInclusive(29900, 0)).toBe(0);
    expect(taxFromInclusive(29900, -100)).toBe(0);
    expect(taxOnExclusive(29900, 0)).toBe(0);
  });

  it('taxes services at 18% inclusive', () => {
    expect(taxFromInclusive(11400, 1800)).toBe(1739);
  });
});

describe('percentOf', () => {
  it('reads its argument as basis points', () => {
    expect(percentOf(29900, 1000)).toBe(2990); // 10%
    expect(percentOf(29900, 100)).toBe(299); // 1%
    expect(percentOf(29900, 10)).toBe(30); // 0.1%, rounded
  });
});

describe('rupees ↔ paise', () => {
  it('round-trips whole and fractional rupees', () => {
    for (const rupees of [0, 1, 249, 299.5, 449.99, 1999.05, 12345.67]) {
      expect(paiseToRupees(rupeesToPaise(rupees))).toBe(rupees);
    }
  });

  it('accepts the decimal string form a provider hands back', () => {
    expect(rupeesToPaise('449.50')).toBe(44950);
    expect(rupeesToPaise('449')).toBe(44900);
    expect(rupeesToPaise('0.01')).toBe(1);
  });

  it('does not lose a paisa to binary floating point', () => {
    // 8.87 * 100 is 886.9999999999999 in IEEE 754 — truncating would charge a
    // paisa less. 0.1 + 0.2 overshoots the other way.
    expect(rupeesToPaise(8.87)).toBe(887);
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
  });

  it('refuses a value that is not a number', () => {
    expect(() => rupeesToPaise('not money')).toThrow(TypeError);
    expect(() => rupeesToPaise(Number.NaN)).toThrow(TypeError);
  });

  it('renders the two-decimal string some provider APIs insist on', () => {
    expect(paiseToDecimalString(44950)).toBe('449.50');
    expect(paiseToDecimalString(44900)).toBe('449.00');
    expect(paiseToDecimalString(7)).toBe('0.07');
    expect(paiseToDecimalString(-44950)).toBe('-449.50');
  });
});

describe('allocateProportionally', () => {
  it('splits a discount in proportion to the line values', () => {
    expect(allocateProportionally(3000, [10000, 20000])).toEqual([1000, 2000]);
  });

  it('pushes the rounding remainder onto the largest line', () => {
    // 100 over 3 equal lines leaves 1 paisa; ties break on the lowest index.
    expect(allocateProportionally(100, [10000, 10000, 10000])).toEqual([34, 33, 33]);
    // 10 over [1, 2] floors to [3, 6] with 1 left; the ₹2 line is larger.
    expect(allocateProportionally(10, [100, 200])).toEqual([3, 7]);
  });

  it('returns zeros when there is nothing to allocate', () => {
    expect(allocateProportionally(0, [10000, 20000])).toEqual([0, 0]);
    expect(allocateProportionally(-500, [10000])).toEqual([0]);
    expect(allocateProportionally(3000, [0, 0])).toEqual([0, 0]);
    expect(allocateProportionally(3000, [])).toEqual([]);
  });

  /**
   * The property that actually matters: an order's line discounts must sum to
   * the order's discount to the paisa, or the invoice does not add up. Checked
   * over a few thousand seeded baskets rather than a handful of examples,
   * because the failure mode is a rounding remainder that only shows up for
   * particular combinations of amounts.
   */
  it('always produces parts that sum exactly to the input', () => {
    const random = seededRandom(0x5eed);
    const pick = (max: number) => 1 + Math.floor(random() * max);

    for (let run = 0; run < 3000; run++) {
      const lineCount = pick(6);
      const weights = Array.from({ length: lineCount }, () => pick(200000));
      const total = pick(weights.reduce((a, b) => a + b, 0));

      const parts = allocateProportionally(total, weights);
      const sum = parts.reduce((a, b) => a + b, 0);
      const weightSum = weights.reduce((a, b) => a + b, 0);

      expect(sum).toBe(total);
      expect(parts).toHaveLength(lineCount);
      for (const [i, part] of parts.entries()) {
        expect(Number.isInteger(part)).toBe(true);
        expect(part).toBeGreaterThanOrEqual(0);
        // Never more than a paisa above the exact proportional share, so no line
        // can absorb a visibly wrong slice of the discount.
        const ideal = Math.floor((total * weights[i]) / weightSum);
        expect(part).toBeGreaterThanOrEqual(ideal);
        expect(part).toBeLessThanOrEqual(ideal + 1);
      }
    }
  });

  it('is deterministic for a given input', () => {
    const weights = [29900, 109800, 74700];
    const once = allocateProportionally(1666, weights);
    const twice = allocateProportionally(1666, weights);
    expect(once).toEqual(twice);
    expect(once.reduce((a, b) => a + b, 0)).toBe(1666);
  });
});
