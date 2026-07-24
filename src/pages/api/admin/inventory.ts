/**
 * Stock, from the kitchen's side.
 *
 * Unlike the storefront — which deliberately says "only a few left" rather than
 * "we have 3" — this reports exact counts, and separates the three numbers that
 * matter: what is on the shelf, what is spoken for by unpaid orders, and what is
 * therefore actually sellable. Confusing the first for the third is how a jar
 * gets sold twice.
 *
 * Writes go through `adjustStock`, never a direct UPDATE, because every movement
 * has to leave a row in `inventory_ledger`. A count that changed with no reason
 * attached is a count nobody can reconcile at the end of the month.
 */

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdmin } from '../../../lib/api';
import { badRequest, notFound } from '../../../lib/errors';
import { handle, ok, readJson } from '../../../lib/http';
import { newId } from '../../../lib/ids';
import { log } from '../../../lib/log';
import { adjustStock, lowStockVariants } from '../../../lib/services/inventory';
import { parseOrThrow } from '../../../lib/validate';

export const prerender = false;

interface StockRow {
  variant_id: string;
  sku: string;
  variant_name: string;
  product_id: string;
  product_name: string;
  price_paise: number;
  on_hand: number;
  reserved: number;
  available: number;
  reorder_level: number;
  track: number;
  updated_at: number | null;
}

export const GET: APIRoute = async ({ locals }) =>
  handle(async () => {
    const { ctx } = requireAdmin(locals);

    // LEFT JOIN, not JOIN: a variant that has never been counted has no
    // inventory row, and leaving it off the list is exactly how it stays
    // uncounted. It shows as zero, which is the truth until someone stocks it.
    const rows = await ctx.db.all<StockRow>(
      `SELECT v.id AS variant_id, v.sku, v.name AS variant_name, v.price_paise,
              p.id AS product_id, p.name AS product_name,
              COALESCE(i.on_hand, 0) AS on_hand,
              COALESCE(i.reserved, 0) AS reserved,
              COALESCE(i.on_hand, 0) - COALESCE(i.reserved, 0) AS available,
              COALESCE(i.reorder_level, 0) AS reorder_level,
              COALESCE(i.track, 1) AS track,
              i.updated_at
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN inventory i ON i.variant_id = v.id
        WHERE v.status = 'active' AND p.status <> 'archived'
        ORDER BY p.sort_order, p.name, v.sort_order, v.weight_grams`,
    );

    return ok({
      variants: rows.map((r) => ({
        variantId: r.variant_id,
        sku: r.sku,
        variantName: r.variant_name,
        productId: r.product_id,
        productName: r.product_name,
        pricePaise: r.price_paise,
        onHand: r.on_hand,
        reserved: r.reserved,
        available: Math.max(0, r.available),
        reorderLevel: r.reorder_level,
        tracked: r.track === 1,
        updatedAt: r.updated_at,
      })),
      lowStock: await lowStockVariants(ctx.db),
    });
  });

const adjustSchema = z.object({
  variant_id: z.string().trim().min(1, 'Choose a variant.'),
  delta: z.coerce
    .number()
    .int('Enter a whole number of jars.')
    .min(-100000, 'That is more than we can remove in one go.')
    .max(100000, 'That is more than we can add in one go.')
    .refine((v) => v !== 0, 'Enter how many jars to add or remove.'),
  /**
   * The reason is the point of the ledger, so it is a closed set rather than
   * free text. `sale` and `cancel` are absent on purpose — those are written by
   * the order path and must never be typed in by hand.
   */
  reason: z.enum(['restock', 'correction', 'spoilage', 'return'], {
    errorMap: () => ({ message: 'Choose a reason: restock, correction, spoilage or return.' }),
  }),
  note: z.string().trim().max(300, 'Keep the note under 300 characters.').optional().nullable(),
});

const reorderLevelSchema = z.object({
  variant_id: z.string().trim().min(1, 'Choose a variant.'),
  reorder_level: z.coerce
    .number()
    .int('Enter a whole number of jars.')
    .min(0, 'A reorder level cannot be negative.')
    .max(100000, 'That reorder level is too high.'),
});

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireAdmin(locals);
    const body = await readJson<Record<string, unknown>>(request);

    const isThresholdUpdate = Object.prototype.hasOwnProperty.call(body, 'reorder_level');
    const variantId = isThresholdUpdate
      ? parseOrThrow(reorderLevelSchema, body).variant_id
      : parseOrThrow(adjustSchema, body).variant_id;

    // Checked before writing so a mistyped id gives "no such variant" rather
    // than a foreign-key error from the upsert inside `adjustStock`.
    const variant = await ctx.db.first<{ id: string; sku: string }>(
      'SELECT id, sku FROM product_variants WHERE id = ?',
      [variantId],
    );
    if (!variant) throw notFound('We could not find that variant.');

    let audit: Record<string, unknown>;

    if (isThresholdUpdate) {
      const { reorder_level: reorderLevel } = parseOrThrow(reorderLevelSchema, body);
      const now = Date.now();
      await ctx.db.run(
        `INSERT INTO inventory (variant_id, on_hand, reserved, reorder_level, track, updated_at)
         VALUES (?, 0, 0, ?, 1, ?)
         ON CONFLICT (variant_id) DO UPDATE SET reorder_level = excluded.reorder_level, updated_at = excluded.updated_at`,
        [variantId, reorderLevel, now],
      );
      audit = { action: 'reorder_level', variantId, sku: variant.sku, reorderLevel };
    } else {
      const { delta, reason, note } = parseOrThrow(adjustSchema, body);
      await adjustStock(ctx.db, variantId, delta, reason, user.id, note ?? undefined);
      audit = { action: 'adjust', variantId, sku: variant.sku, delta, reason, note: note ?? null };
    }

    await ctx.db.run(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, data_json, ip, created_at)
       VALUES (?, 'admin', ?, ?, 'variant', ?, ?, ?, ?)`,
      [
        newId('aud'),
        user.id,
        isThresholdUpdate ? 'inventory.reorder_level' : 'inventory.adjust',
        variantId,
        JSON.stringify(audit),
        ctx.clientIp,
        Date.now(),
      ],
    );

    const fresh = await ctx.db.first<{
      on_hand: number;
      reserved: number;
      reorder_level: number;
      track: number;
    }>('SELECT on_hand, reserved, reorder_level, track FROM inventory WHERE variant_id = ?', [variantId]);
    if (!fresh) throw badRequest('That stock change did not take. Please try again.');

    log.info('admin.inventory_write', { variantId, actorId: user.id, ...audit });

    return ok({
      variantId,
      sku: variant.sku,
      onHand: fresh.on_hand,
      reserved: fresh.reserved,
      available: Math.max(0, fresh.on_hand - fresh.reserved),
      reorderLevel: fresh.reorder_level,
      tracked: fresh.track === 1,
    });
  });
