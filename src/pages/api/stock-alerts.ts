/**
 * "Tell me when this is back."
 *
 * Small-batch pickle sells out between batches, so this is the only way a
 * customer can hold their place. The row is the whole feature — the cron sweep
 * is what mails the list when stock lands.
 */

import type { APIRoute } from 'astro';
import { rateKey, requireCtx } from '../../lib/api';
import { conflict } from '../../lib/errors';
import { handle, ok, readJson } from '../../lib/http';
import { newId } from '../../lib/ids';
import { log, maskEmail } from '../../lib/log';
import { RATE_LIMITS, enforceRateLimit } from '../../lib/rate-limit';
import { getSellableVariant } from '../../lib/services/catalog';
import { parseOrThrow, stockAlertSchema } from '../../lib/validate';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    const input = parseOrThrow(stockAlertSchema, await readJson(request));
    // Anonymous write that stores an email address, so it gets the same ceiling
    // as the other public forms.
    await enforceRateLimit(ctx.db, rateKey(ctx, 'stock-alert'), RATE_LIMITS.contact);

    // Nothing to wait for if it is on the shelf right now. Saying so is better
    // than accepting a subscription that would never fire.
    const variant = await getSellableVariant(ctx.db, input.variant_id);
    if (variant.inStock) {
      throw conflict(`${variant.productName} ${variant.name} is in stock right now — you can order it today.`);
    }

    // A second sign-up for the same jar is the same request, not a new one.
    await ctx.db.run(
      `INSERT INTO stock_alerts (id, variant_id, email, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (variant_id, email) DO NOTHING`,
      [newId('alr'), input.variant_id, input.email, Date.now()],
    );

    log.info('stock_alert.registered', { variantId: input.variant_id, email: maskEmail(input.email) });
    return ok({ registered: true });
  });
