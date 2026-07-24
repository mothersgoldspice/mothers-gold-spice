/**
 * Store settings.
 *
 * This is the most dangerous PATCH in the system. Nothing here fails loudly: a
 * shipping rate typed with one zero too many does not throw, it just quietly
 * charges every customer in zone C ten times too much until somebody notices.
 * So the schema is `.strict()` and every number is checked rather than coerced —
 * an unrecognised key is a mistake worth rejecting, not a field worth ignoring,
 * and `"4900abc"` becoming 4900 is exactly the kind of helpfulness that ships a
 * wrong price.
 *
 * The patch is partial by design (an operator toggles COD without re-sending the
 * whole configuration), so the cross-field checks run against the MERGED result,
 * not against the handful of keys that happened to arrive.
 */

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdmin } from '../../../lib/api';
import { badRequest } from '../../../lib/errors';
import { handle, ok, readJson } from '../../../lib/http';
import { newId } from '../../../lib/ids';
import { log } from '../../../lib/log';
import { formatPaise } from '../../../lib/money';
import { loadSettings, saveSettings, type ShippingRate, type StoreSettings } from '../../../lib/settings';
import type { Zone } from '../../../lib/shipping-zones';
import { parseOrThrow, phoneSchema, pincodeSchema } from '../../../lib/validate';

export const prerender = false;

/**
 * Every money field. The ceiling is a sanity rail, not a business limit: no
 * legitimate value here is anywhere near ₹1,00,000, so a number above it is
 * almost certainly rupees typed into a paise field.
 */
const paise = z
  .number({ invalid_type_error: 'Enter an amount in paise, as a plain number.' })
  .int('Amounts are whole paise — no decimals.')
  .min(0, 'That amount cannot be negative.')
  .max(10_000_000, 'That amount is far higher than we allow. Amounts are in paise, not rupees.');

const shippingRateSchema = z
  .object({
    first500g: paise,
    perExtra500g: paise,
  })
  .strict();

/** Blank clears the field; anything else must be a real number. */
const optionalPhone = z.union([z.literal(''), phoneSchema]);

const settingsPatchSchema = z
  .object({
    storeOpen: z.boolean(),
    storeClosedMessage: z.string().trim().min(1, 'Say something — a blank notice helps nobody.').max(300),

    taxEnabled: z.boolean(),
    taxInclusive: z.boolean(),
    defaultTaxRateBps: z
      .number()
      .int('GST rates are whole basis points — 12% is 1200.')
      .min(0, 'A tax rate cannot be negative.')
      .max(5000, 'That is above 50% — check whether you meant basis points.'),

    freeShippingThresholdPaise: paise,
    // A partial zone is refused: half a rate is not a rate, and the missing half
    // would silently fall back to the code default for that zone only.
    shippingRates: z
      .object({
        A: shippingRateSchema,
        B: shippingRateSchema,
        C: shippingRateSchema,
        D: shippingRateSchema,
        E: shippingRateSchema,
      })
      .partial()
      .strict()
      .refine((v) => Object.keys(v).length > 0, 'Give at least one zone rate.'),

    codEnabled: z.boolean(),
    codFeePaise: paise,
    codMinOrderPaise: paise,
    codMaxOrderPaise: paise,

    maxQtyPerVariant: z.number().int().min(1, 'At least one jar per line.').max(100),
    maxItemsPerOrder: z.number().int().min(1, 'At least one jar per order.').max(500),

    reservationMinutes: z
      .number()
      .int()
      .min(5, 'Give people at least five minutes to pay.')
      .max(1440, 'Holding stock for more than a day starves the shop.'),

    parcelDimensionsCm: z
      .object({
        length: z.number().int().min(1).max(150),
        breadth: z.number().int().min(1).max(150),
        height: z.number().int().min(1).max(150),
      })
      .strict(),
    packagingWeightGrams: z.number().int().min(0).max(5000),

    originPincode: pincodeSchema,
    originCity: z.string().trim().min(2).max(80),
    originState: z.string().trim().min(2).max(80),

    gstin: z.union([
      z.literal(''),
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'That does not look like a 15-character GSTIN.'),
    ]),
    fssaiLicence: z.union([
      z.literal(''),
      z
        .string()
        .trim()
        .regex(/^[0-9]{14}$/, 'An FSSAI licence number is 14 digits.'),
    ]),
    legalEntityName: z.string().trim().min(2).max(120),
    registeredAddress: z.string().trim().min(4).max(300),

    supportPhone: optionalPhone,
    whatsappNumber: optionalPhone,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'There is nothing to save.');

export const GET: APIRoute = async ({ locals }) =>
  handle(async () => {
    const { ctx } = requireAdmin(locals);
    // Read straight from the database rather than `ctx.settings()`: the cached
    // copy is for pricing this request, and the settings screen must show what
    // is stored, not what was loaded before somebody else saved.
    return ok(await loadSettings(ctx.db));
  });

export const PATCH: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireAdmin(locals);
    const input = parseOrThrow(settingsPatchSchema, await readJson<Record<string, unknown>>(request));

    const current = await loadSettings(ctx.db);

    // `saveSettings` merges one level deep, but its type wants a complete rate
    // table, so the merge for the nested objects happens here where the current
    // values are in hand.
    const { shippingRates, ...rest } = input;
    const patch: Partial<StoreSettings> = { ...rest };
    if (shippingRates) {
      const partial: Partial<Record<Zone, ShippingRate>> = shippingRates;
      patch.shippingRates = { ...current.shippingRates, ...partial };
    }

    const merged: StoreSettings = {
      ...current,
      ...patch,
      shippingRates: patch.shippingRates ?? current.shippingRates,
      parcelDimensionsCm: patch.parcelDimensionsCm ?? current.parcelDimensionsCm,
    };

    // Cross-field sanity, checked on the merged result: sending only a new
    // minimum must not be able to cross a maximum that was never in the patch.
    if (merged.codMinOrderPaise > merged.codMaxOrderPaise) {
      throw badRequest(
        `The cash-on-delivery minimum (${formatPaise(merged.codMinOrderPaise)}) cannot be above the maximum (${formatPaise(merged.codMaxOrderPaise)}).`,
      );
    }
    if (merged.maxQtyPerVariant > merged.maxItemsPerOrder) {
      throw badRequest('The per-variant limit cannot be higher than the whole-order limit.');
    }
    for (const [zone, rate] of Object.entries(merged.shippingRates)) {
      if (rate.perExtra500g > rate.first500g) {
        throw badRequest(
          `Zone ${zone}: the extra-500g rate (${formatPaise(rate.perExtra500g)}) is above the first-500g rate (${formatPaise(rate.first500g)}). Check the two numbers.`,
        );
      }
    }

    const saved = await saveSettings(ctx.db, patch, user.id);
    // A later step in this same request must price with the new numbers.
    ctx.invalidateSettings();

    await ctx.db.run(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, data_json, ip, created_at)
       VALUES (?, 'admin', ?, 'settings.update', 'settings', 'store_settings', ?, ?, ?)`,
      [newId('aud'), user.id, JSON.stringify({ changed: Object.keys(input), patch }), ctx.clientIp, Date.now()],
    );

    log.info('admin.settings_saved', { actorId: user.id, changed: Object.keys(input) });
    return ok(saved);
  });
