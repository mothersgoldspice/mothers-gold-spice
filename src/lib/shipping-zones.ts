/**
 * Pincode → shipping zone, from a Bangalore (560xxx) origin.
 *
 * The zone letters match the rate table in /shipping: A within city, B within
 * Karnataka, C metro-to-metro, D rest of India, E the far/special zones (North
 * East, J&K, Ladakh, islands) where every courier charges a premium and takes a
 * week. Zone is what the customer-facing shipping price is derived from, and it
 * is computed locally so a quote never has to wait on the courier API.
 */

export type Zone = 'A' | 'B' | 'C' | 'D' | 'E';

export const ORIGIN_PINCODE = '560001';

/** First three digits of pincodes served by metro-to-metro rates. */
const METRO_PREFIXES = new Set([
  '110', '111', '112', // Delhi
  '120', '121', '122', '123', '124', // Gurgaon / Faridabad NCR
  '201', '203', // Noida / Ghaziabad
  '400', '401', '402', '410', '421', // Mumbai / Thane / Navi Mumbai
  '411', '412', // Pune
  '380', '382', // Ahmedabad
  '500', '501', '502', // Hyderabad
  '600', '601', '602', '603', // Chennai
  '700', '711', // Kolkata / Howrah
  '682', // Kochi
  '302', // Jaipur
  '160', // Chandigarh
]);

/** Two-digit prefixes for the premium/remote zone. */
const SPECIAL_2 = new Set([
  '78', '79', // North East (Assam, Arunachal, Nagaland, Manipur, Mizoram, Tripura, Meghalaya)
  '18', '19', // Jammu & Kashmir, Ladakh
]);

/** Three-digit prefixes for islands. */
const SPECIAL_3 = new Set(['744', '682']); // Andaman & Nicobar; Lakshadweep routes via Kochi

export function isValidPincode(pincode: string): boolean {
  return /^[1-9][0-9]{5}$/.test(pincode.trim());
}

export function zoneForPincode(pincode: string): Zone {
  const pin = pincode.trim();
  if (!isValidPincode(pin)) return 'D';

  const p2 = pin.slice(0, 2);
  const p3 = pin.slice(0, 3);

  // Islands and the far north are checked first — 744 (Andaman) would otherwise
  // fall through to "rest of India" and be under-quoted by ~₹40 a parcel.
  if (SPECIAL_2.has(p2)) return 'E';
  if (p3 === '744') return 'E';
  if (p3 === '682' && pin.startsWith('682555')) return 'E'; // Lakshadweep

  if (p3 === '560' || p3 === '562') return 'A'; // Bengaluru urban + rural
  if (['56', '57', '58', '59'].includes(p2)) return 'B'; // rest of Karnataka

  if (METRO_PREFIXES.has(p3)) return 'C';
  if (SPECIAL_3.has(p3)) return 'C';

  return 'D';
}

/** Human label for the zone, shown at checkout next to the delivery estimate. */
export const ZONE_LABEL: Record<Zone, string> = {
  A: 'Bengaluru',
  B: 'Karnataka',
  C: 'Metro',
  D: 'Rest of India',
  E: 'Remote / North East / Islands',
};

/** Delivery estimate in days, used when the courier does not return an ETD. */
export const ZONE_ETD_DAYS: Record<Zone, number> = { A: 2, B: 3, C: 5, D: 6, E: 9 };

/**
 * What the COURIER costs us per 500 g slab, paise. Straight from the rate
 * research in /shipping — used by the mock provider to quote realistically and
 * by the admin margin view. NOT what the customer is charged (see settings).
 */
export const ZONE_COURIER_COST_PAISE: Record<Zone, { first500g: number; perExtra500g: number }> = {
  A: { first500g: 4500, perExtra500g: 2000 },
  B: { first500g: 6500, perExtra500g: 2500 },
  C: { first500g: 8500, perExtra500g: 3000 },
  D: { first500g: 11000, perExtra500g: 3500 },
  E: { first500g: 14000, perExtra500g: 5000 },
};

/**
 * Couriers bill on the greater of actual and volumetric weight. A tightly packed
 * 13×13×13 cm box for one jar is 440 g volumetric, which keeps a 500 g jar in the
 * 500 g slab instead of spilling into the next one.
 */
export function volumetricWeightGrams(lengthCm: number, breadthCm: number, heightCm: number): number {
  return Math.round(((lengthCm * breadthCm * heightCm) / 5000) * 1000);
}

export function billableWeightGrams(actualGrams: number, pkg?: { l: number; b: number; h: number }): number {
  if (!pkg) return actualGrams;
  return Math.max(actualGrams, volumetricWeightGrams(pkg.l, pkg.b, pkg.h));
}

/** Number of 500 g slabs a parcel occupies (minimum 1). */
export function weightSlabs(weightGrams: number): number {
  return Math.max(1, Math.ceil(weightGrams / 500));
}
