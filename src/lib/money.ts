/**
 * Money is INTEGER paise everywhere — in the database, in service arguments, and
 * over the wire. Rupees only exist at the display edge and at the boundary of a
 * provider that insists on a decimal string.
 *
 * Floats are never used for arithmetic: ₹449.00 is 44900, and 12% GST on it is
 * computed with integer rounding, so 100 orders never drift a paisa.
 */

export const CURRENCY = 'INR';

/** ₹449.5 → 44950. Accepts a number or a "449.50" string. */
export function rupeesToPaise(rupees: number | string): number {
  const n = typeof rupees === 'string' ? Number.parseFloat(rupees) : rupees;
  if (!Number.isFinite(n)) throw new TypeError(`rupeesToPaise: not a number: ${rupees}`);
  return Math.round(n * 100);
}

/** 44950 → 449.5 — for provider payloads that want a decimal amount. */
export function paiseToRupees(paise: number): number {
  return Math.round(paise) / 100;
}

/** 44950 → "449.50" — decimal string form some provider APIs require. */
export function paiseToDecimalString(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(Math.round(paise));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Display form. `44900` → `₹449`, `44950` → `₹449.50`.
 * Whole rupees drop the decimals — Indian price tags read `₹449`, not `₹449.00`.
 */
export function formatPaise(paise: number, opts: { withSymbol?: boolean; forceDecimals?: boolean } = {}): string {
  const { withSymbol = true, forceDecimals = false } = opts;
  const negative = paise < 0;
  const abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / 100);
  const pais = abs % 100;
  const grouped = groupIndian(rupees);
  const body = pais === 0 && !forceDecimals ? grouped : `${grouped}.${String(pais).padStart(2, '0')}`;
  return `${negative ? '-' : ''}${withSymbol ? '₹' : ''}${body}`;
}

/** Indian digit grouping: 1234567 → "12,34,567". */
export function groupIndian(n: number): string {
  const s = String(n);
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/**
 * GST on a tax-INCLUSIVE price. Indian MRP is inclusive by law, so ₹449 at 12%
 * contains ₹48.11 of tax rather than attracting ₹53.88 on top.
 *
 * `rateBps` is basis points: 1200 = 12%.
 */
export function taxFromInclusive(grossPaise: number, rateBps: number): number {
  if (rateBps <= 0) return 0;
  return Math.round((grossPaise * rateBps) / (10000 + rateBps));
}

/** GST added on top of a tax-EXCLUSIVE amount (used for shipping when charged separately). */
export function taxOnExclusive(netPaise: number, rateBps: number): number {
  if (rateBps <= 0) return 0;
  return Math.round((netPaise * rateBps) / 10000);
}

/** Percentage of an amount in basis points, rounded to the nearest paisa. */
export function percentOf(paise: number, bps: number): number {
  return Math.round((paise * bps) / 10000);
}

/**
 * Split a discount across line items proportionally to their subtotals, with the
 * rounding remainder pushed onto the largest line. The parts always sum exactly
 * to `totalDiscount` — otherwise an order's items would not add up to its total.
 */
export function allocateProportionally(totalDiscount: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || totalDiscount <= 0) return weights.map(() => 0);

  const parts = weights.map((w) => Math.floor((totalDiscount * w) / sum));
  let remainder = totalDiscount - parts.reduce((a, b) => a + b, 0);

  // Hand the leftover paise out one at a time, largest weight first, so the
  // allocation is deterministic for a given input.
  const order = weights.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w || a.i - b.i);
  let k = 0;
  while (remainder > 0 && order.length > 0) {
    parts[order[k % order.length].i] += 1;
    remainder -= 1;
    k += 1;
  }
  return parts;
}
