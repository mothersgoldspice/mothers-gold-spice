/**
 * Store settings — the knobs an operator changes without a deploy.
 *
 * Defaults live here in code so a fresh database is immediately a working shop;
 * the `settings` table only ever holds overrides. That means adding a new knob
 * never needs a migration or a seed, and a partially-populated table cannot
 * produce an order priced from `undefined`.
 */

import type { Db } from './db/client';
import { parseJson } from './db/client';
import type { Zone } from './shipping-zones';

export interface ShippingRate {
  /** Charged to the customer for the first 500 g slab, paise. */
  first500g: number;
  /** Each additional 500 g slab, paise. */
  perExtra500g: number;
}

export interface StoreSettings {
  /** Master switch — turns off add-to-cart and checkout with a notice. */
  storeOpen: boolean;
  storeClosedMessage: string;

  /** GST is charged inclusive of MRP, the Indian retail convention. */
  taxEnabled: boolean;
  taxInclusive: boolean;
  /** Fallback rate when a variant has none, basis points. */
  defaultTaxRateBps: number;

  /** Free shipping at or above this order subtotal (after discount). */
  freeShippingThresholdPaise: number;
  shippingRates: Record<Zone, ShippingRate>;

  codEnabled: boolean;
  codFeePaise: number;
  codMinOrderPaise: number;
  codMaxOrderPaise: number;

  /** Per-line and per-order caps, to stop a fat-fingered qty draining stock. */
  maxQtyPerVariant: number;
  maxItemsPerOrder: number;

  /** How long an unpaid order holds its stock reservation, minutes. */
  reservationMinutes: number;

  /** Parcel dimensions used for the volumetric weight calculation, cm. */
  parcelDimensionsCm: { length: number; breadth: number; height: number };
  /** Packaging weight added on top of net product weight, grams. */
  packagingWeightGrams: number;

  originPincode: string;
  originCity: string;
  originState: string;

  /** Shown on invoices once registration lands; blank hides the line. */
  gstin: string;
  fssaiLicence: string;
  legalEntityName: string;
  registeredAddress: string;

  supportPhone: string;
  whatsappNumber: string;
}

export const DEFAULT_SETTINGS: StoreSettings = {
  storeOpen: true,
  storeClosedMessage: 'We are between batches right now — new jars go on sale shortly.',

  taxEnabled: true,
  taxInclusive: true,
  // Fruit pickle in a unit container sits at 12% GST (HSN 2001). Confirm with a
  // CA before the first filing; the rate is per-variant so it can be corrected
  // without touching this default.
  defaultTaxRateBps: 1200,

  freeShippingThresholdPaise: 99900, // ₹999 — roughly a two-jar basket
  shippingRates: {
    A: { first500g: 4900, perExtra500g: 2500 },
    B: { first500g: 6900, perExtra500g: 3000 },
    C: { first500g: 8900, perExtra500g: 3500 },
    D: { first500g: 10900, perExtra500g: 4000 },
    E: { first500g: 14900, perExtra500g: 5000 },
  },

  codEnabled: true,
  codFeePaise: 4000, // ₹40 — covers the courier's COD handling fee
  codMinOrderPaise: 29900,
  codMaxOrderPaise: 500000,

  maxQtyPerVariant: 12,
  maxItemsPerOrder: 40,

  reservationMinutes: 30,

  parcelDimensionsCm: { length: 13, breadth: 13, height: 13 },
  packagingWeightGrams: 250,

  originPincode: '560001',
  originCity: 'Bengaluru',
  originState: 'Karnataka',

  gstin: '',
  fssaiLicence: '',
  legalEntityName: "Mother's Gold Spice",
  registeredAddress: 'Bengaluru, Karnataka, India',

  supportPhone: '',
  whatsappNumber: '',
};

const SETTINGS_KEY = 'store_settings';

export async function loadSettings(db: Db): Promise<StoreSettings> {
  const row = await db.first<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', [SETTINGS_KEY]);
  if (!row) return { ...DEFAULT_SETTINGS };

  const overrides = parseJson<Partial<StoreSettings>>(row.value_json, {});
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    // Nested objects merge one level deep so an override of a single zone does
    // not wipe the other four.
    shippingRates: { ...DEFAULT_SETTINGS.shippingRates, ...(overrides.shippingRates ?? {}) },
    parcelDimensionsCm: { ...DEFAULT_SETTINGS.parcelDimensionsCm, ...(overrides.parcelDimensionsCm ?? {}) },
  };
}

export async function saveSettings(db: Db, patch: Partial<StoreSettings>, actorId: string): Promise<StoreSettings> {
  const current = await loadSettings(db);
  const next: StoreSettings = {
    ...current,
    ...patch,
    shippingRates: { ...current.shippingRates, ...(patch.shippingRates ?? {}) },
    parcelDimensionsCm: { ...current.parcelDimensionsCm, ...(patch.parcelDimensionsCm ?? {}) },
  };
  await db.run(
    `INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [SETTINGS_KEY, JSON.stringify(next), Date.now(), actorId],
  );
  return next;
}
