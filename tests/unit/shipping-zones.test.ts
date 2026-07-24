/**
 * Pincode → zone, and the weight arithmetic the courier bills on.
 *
 * The tricky cases are the ones that cost money when they are wrong: a pincode
 * that falls through to "rest of India" is under-quoted by ₹40 a parcel, and a
 * parcel that spills into an extra 500 g slab is over-quoted by the same.
 */

import { describe, expect, it } from 'vitest';

import {
  ORIGIN_PINCODE,
  ZONE_COURIER_COST_PAISE,
  ZONE_ETD_DAYS,
  ZONE_LABEL,
  billableWeightGrams,
  isValidPincode,
  volumetricWeightGrams,
  weightSlabs,
  zoneForPincode,
  type Zone,
} from '../../src/lib/shipping-zones';

describe('isValidPincode', () => {
  it('accepts six digits that do not start with zero', () => {
    expect(isValidPincode('560001')).toBe(true);
    expect(isValidPincode(' 560041 ')).toBe(true);
    expect(isValidPincode(ORIGIN_PINCODE)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isValidPincode('056001')).toBe(false);
    expect(isValidPincode('56001')).toBe(false);
    expect(isValidPincode('5600011')).toBe(false);
    expect(isValidPincode('56000a')).toBe(false);
    expect(isValidPincode('')).toBe(false);
  });
});

describe('zoneForPincode', () => {
  it('puts Bengaluru urban and rural in zone A', () => {
    expect(zoneForPincode('560001')).toBe('A');
    expect(zoneForPincode('560041')).toBe('A');
    expect(zoneForPincode('560103')).toBe('A');
    expect(zoneForPincode('562130')).toBe('A'); // Bengaluru rural
    expect(zoneForPincode('562159')).toBe('A');
  });

  it('puts the rest of Karnataka in zone B', () => {
    expect(zoneForPincode('570001')).toBe('B'); // Mysuru
    expect(zoneForPincode('580001')).toBe('B'); // Hubballi
    expect(zoneForPincode('590001')).toBe('B'); // Belagavi
    expect(zoneForPincode('561101')).toBe('B'); // 56x that is not 560/562
  });

  it('puts the metros in zone C', () => {
    expect(zoneForPincode('110001')).toBe('C'); // Delhi
    expect(zoneForPincode('122001')).toBe('C'); // Gurugram
    expect(zoneForPincode('201301')).toBe('C'); // Noida
    expect(zoneForPincode('400001')).toBe('C'); // Mumbai
    expect(zoneForPincode('411001')).toBe('C'); // Pune
    expect(zoneForPincode('380001')).toBe('C'); // Ahmedabad
    expect(zoneForPincode('500001')).toBe('C'); // Hyderabad
    expect(zoneForPincode('600001')).toBe('C'); // Chennai
    expect(zoneForPincode('700001')).toBe('C'); // Kolkata
    expect(zoneForPincode('302001')).toBe('C'); // Jaipur
    expect(zoneForPincode('160001')).toBe('C'); // Chandigarh
    expect(zoneForPincode('682001')).toBe('C'); // Kochi
  });

  it('puts the Andamans in zone E rather than letting 744 fall through to D', () => {
    expect(zoneForPincode('744101')).toBe('E');
    expect(zoneForPincode('744301')).toBe('E');
  });

  it('puts the North East in zone E', () => {
    expect(zoneForPincode('781001')).toBe('E'); // Guwahati, Assam
    expect(zoneForPincode('783301')).toBe('E');
    expect(zoneForPincode('790001')).toBe('E'); // Arunachal
    expect(zoneForPincode('799001')).toBe('E'); // Tripura
  });

  it('puts Jammu, Kashmir and Ladakh in zone E', () => {
    expect(zoneForPincode('180001')).toBe('E'); // Jammu
    expect(zoneForPincode('190001')).toBe('E'); // Srinagar
    expect(zoneForPincode('194101')).toBe('E'); // Leh
  });

  it('routes Lakshadweep to E even though it shares Kochi’s 682 prefix', () => {
    expect(zoneForPincode('682555')).toBe('E');
    expect(zoneForPincode('682001')).toBe('C');
  });

  it('puts everything else in zone D', () => {
    expect(zoneForPincode('452001')).toBe('D'); // Indore
    expect(zoneForPincode('226001')).toBe('D'); // Lucknow
    expect(zoneForPincode('751001')).toBe('D'); // Bhubaneswar
    expect(zoneForPincode('403001')).toBe('D'); // Goa
  });

  it('falls back to D for an unusable pincode rather than throwing at checkout', () => {
    expect(zoneForPincode('')).toBe('D');
    expect(zoneForPincode('abcdef')).toBe('D');
    expect(zoneForPincode('000000')).toBe('D');
  });

  it('tolerates surrounding whitespace', () => {
    expect(zoneForPincode('  560001  ')).toBe('A');
  });
});

describe('volumetric weight', () => {
  it('divides by the 5000 divisor couriers use', () => {
    // The standard 13 x 13 x 13 cm one-jar box.
    expect(volumetricWeightGrams(13, 13, 13)).toBe(439);
    expect(volumetricWeightGrams(20, 20, 10)).toBe(800);
    expect(volumetricWeightGrams(10, 10, 10)).toBe(200);
  });

  it('bills on the greater of actual and volumetric', () => {
    const box = { l: 13, b: 13, h: 13 };
    // A 500 g jar is heavier than its box is bulky, so actual weight wins and
    // the parcel stays inside one 500 g slab.
    expect(billableWeightGrams(500, box)).toBe(500);
    expect(weightSlabs(billableWeightGrams(500, box))).toBe(1);

    // A light but bulky parcel is billed on the box.
    expect(billableWeightGrams(300, box)).toBe(439);
  });

  it('bills on actual weight when no box is given', () => {
    expect(billableWeightGrams(870)).toBe(870);
  });
});

describe('weightSlabs', () => {
  it('always charges at least one slab', () => {
    expect(weightSlabs(0)).toBe(1);
    expect(weightSlabs(1)).toBe(1);
    expect(weightSlabs(-50)).toBe(1);
  });

  it('rolls over on the 500 g boundary, not before it', () => {
    expect(weightSlabs(499)).toBe(1);
    expect(weightSlabs(500)).toBe(1);
    expect(weightSlabs(501)).toBe(2);
    expect(weightSlabs(1000)).toBe(2);
    expect(weightSlabs(1001)).toBe(3);
    expect(weightSlabs(1490)).toBe(3); // two 500 g jars plus packaging
  });
});

describe('zone tables', () => {
  const zones: Zone[] = ['A', 'B', 'C', 'D', 'E'];

  it('covers every zone', () => {
    for (const zone of zones) {
      expect(ZONE_LABEL[zone]).toBeTruthy();
      expect(ZONE_ETD_DAYS[zone]).toBeGreaterThan(0);
      expect(ZONE_COURIER_COST_PAISE[zone].first500g).toBeGreaterThan(0);
    }
  });

  it('gets slower and dearer the further out the zone is', () => {
    for (let i = 1; i < zones.length; i++) {
      const near = zones[i - 1];
      const far = zones[i];
      expect(ZONE_ETD_DAYS[far]).toBeGreaterThan(ZONE_ETD_DAYS[near]);
      expect(ZONE_COURIER_COST_PAISE[far].first500g).toBeGreaterThan(ZONE_COURIER_COST_PAISE[near].first500g);
    }
  });
});
