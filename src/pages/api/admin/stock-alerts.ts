/**
 * The waiting list, which is really a production plan.
 *
 * Five people holding out for the 500 g and nobody for the 250 g is the clearest
 * instruction this shop ever receives about what to cook next, and until now it
 * was only visible by reading the table by hand.
 *
 * The queries live in `services/stock-alerts.ts` — `waitingSummary` for the
 * counts and `listWaiting` for the individual requests — so the admin page and
 * this route cannot drift apart in what "waiting" means.
 *
 * The one write here is a manual send. It exists because the automatic path only
 * fires when stock MOVES: a restock, a cancellation, a refund. An alert recorded
 * while the shelf already had jars on it — a race with a concurrent order, or a
 * variant marked active after the fact — sits there forever with nothing to
 * trigger it. This screen shows exactly that state, so it also has to be able to
 * resolve it, otherwise the only cure is a fake +1/-1 adjustment on the
 * inventory screen, which lies to the ledger.
 */

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdmin } from '../../../lib/api';
import { notFound } from '../../../lib/errors';
import { handle, ok, readJson } from '../../../lib/http';
import { newId } from '../../../lib/ids';
import { log } from '../../../lib/log';
import { listWaiting, notifyBackInStock, waitingSummary } from '../../../lib/services/stock-alerts';
import { parseOrThrow } from '../../../lib/validate';

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) =>
  handle(async () => {
    const { ctx } = requireAdmin(locals);

    const summary = await waitingSummary(ctx);

    // `variant_id` opens one row: who is waiting, oldest request first. Absent,
    // the caller gets the counts only — nobody needs every address on the shop
    // to answer "what should we cook next".
    const variantId = url.searchParams.get('variant_id');
    const waiting = variantId ? await listWaiting(ctx, variantId) : [];

    return ok({
      summary,
      totalWaiting: summary.reduce((sum, row) => sum + row.waiting, 0),
      variantId,
      waiting,
    });
  });

const notifySchema = z
  .object({
    action: z.literal('notify', {
      errorMap: () => ({ message: 'The only action here is notify.' }),
    }),
    variant_id: z.string().trim().min(1, 'Choose a variant.'),
  })
  .strict();

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireAdmin(locals);
    const input = parseOrThrow(notifySchema, await readJson<Record<string, unknown>>(request));

    const variant = await ctx.db.first<{ id: string; sku: string }>('SELECT id, sku FROM product_variants WHERE id = ?', [
      input.variant_id,
    ]);
    if (!variant) throw notFound('We could not find that variant.');

    // Availability is re-read inside the service, so a variant that is in fact
    // sold out notifies nobody and promises nothing. `notified_at` is stamped in
    // the same pass, so pressing this twice does not mail anyone twice.
    const { notified } = await notifyBackInStock(ctx, [variant.id]);

    await ctx.db.run(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, data_json, ip, created_at)
       VALUES (?, 'admin', ?, 'stock_alerts.notify', 'variant', ?, ?, ?, ?)`,
      [
        newId('aud'),
        user.id,
        variant.id,
        JSON.stringify({ sku: variant.sku, notified }),
        ctx.clientIp,
        Date.now(),
      ],
    );

    log.info('admin.stock_alerts_notify', { actorId: user.id, variantId: variant.id, notified });

    return ok({ variantId: variant.id, sku: variant.sku, notified });
  });
