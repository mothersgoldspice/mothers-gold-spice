/**
 * "Tell me when it is back."
 *
 * The product page has offered this since launch and the email template has
 * existed just as long, but nothing ever sent it — a customer typed their
 * address, got a confirmation, and was never written to. A promise made and not
 * kept is worse than not offering the box at all, so this is the missing half.
 *
 * Triggered by anything that puts units back on the shelf: an admin restock, a
 * cancelled order, a refunded order. Not by a reservation being released, which
 * is a different thing — those units were never gone.
 */

import type { AppContext } from '../context';
import { siteUrl } from '../env';
import { newId } from '../ids';
import { errMessage, log, maskEmail } from '../log';
import { backInStock, storeContext } from '../providers/email/templates';
import { queueEmail } from './notify';

export interface WaitingAlert {
  id: string;
  variantId: string;
  email: string;
  createdAt: number;
}

/** Who is still waiting on a given variant, oldest request first. */
export async function listWaiting(ctx: AppContext, variantId: string): Promise<WaitingAlert[]> {
  const rows = await ctx.db.all<{ id: string; variant_id: string; email: string; created_at: number }>(
    'SELECT id, variant_id, email, created_at FROM stock_alerts WHERE variant_id = ? AND notified_at IS NULL ORDER BY created_at',
    [variantId],
  );
  return rows.map((r) => ({ id: r.id, variantId: r.variant_id, email: r.email, createdAt: r.created_at }));
}

/**
 * Notify everyone waiting on these variants, but only where there is genuinely
 * something to buy.
 *
 * Availability is re-read here rather than trusted from the caller: a restock of
 * two jars against five waiting customers should still only promise what exists,
 * and the caller knows what it added, not what is left after concurrent orders.
 *
 * `notified_at` is stamped in the same pass, so a second restock an hour later
 * does not mail the same person again. That is a one-way door on purpose — being
 * told twice about one batch is more annoying than being told once.
 */
export async function notifyBackInStock(ctx: AppContext, variantIds: string[]): Promise<{ notified: number }> {
  const unique = [...new Set(variantIds.filter(Boolean))];
  if (unique.length === 0) return { notified: 0 };

  const placeholders = unique.map(() => '?').join(', ');
  const rows = await ctx.db.all<{
    alert_id: string;
    email: string;
    variant_id: string;
    variant_name: string;
    product_name: string;
    product_slug: string;
    price_paise: number;
    available: number;
  }>(
    `SELECT a.id AS alert_id, a.email, a.variant_id,
            v.name AS variant_name, v.price_paise,
            p.name AS product_name, p.slug AS product_slug,
            CASE WHEN i.track = 0 THEN 999999 ELSE (i.on_hand - i.reserved) END AS available
       FROM stock_alerts a
       JOIN product_variants v ON v.id = a.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN inventory i ON i.variant_id = a.variant_id
      WHERE a.variant_id IN (${placeholders})
        AND a.notified_at IS NULL
        AND v.status = 'active'
        AND p.status = 'active'
      ORDER BY a.created_at`,
    unique,
  );

  const ready = rows.filter((r) => (r.available ?? 0) > 0);
  if (ready.length === 0) return { notified: 0 };

  const store = storeContext(ctx.env);
  const base = siteUrl(ctx.env);
  const now = Date.now();
  let notified = 0;

  for (const row of ready) {
    try {
      const mail = backInStock({
        store,
        name: 'there',
        productName: row.product_name,
        variantName: row.variant_name,
        pricePaise: row.price_paise,
        buyUrl: `${base}/shop/${row.product_slug}`,
        // Marketing mail, so the footer must offer a way out. There is no
        // account behind a stock alert, so the address itself is the identity.
        unsubscribeUrl: `${base}/unsubscribe?e=${encodeURIComponent(row.email)}`,
      });

      await queueEmail(ctx, {
        to: row.email,
        subject: mail.subject,
        template: mail.template,
        text: mail.text,
        html: mail.html,
        // One notification per person per variant, ever.
        idempotencyKey: `back_in_stock:${row.variant_id}:${row.email}`,
      });

      await ctx.db.run('UPDATE stock_alerts SET notified_at = ? WHERE id = ? AND notified_at IS NULL', [
        now,
        row.alert_id,
      ]);
      notified += 1;
    } catch (err) {
      // One bad address must not stop the rest of the queue.
      log.error('stock_alerts.notify_failed', {
        variantId: row.variant_id,
        email: maskEmail(row.email),
        error: errMessage(err),
      });
    }
  }

  if (notified > 0) {
    log.info('stock_alerts.notified', { variants: unique.length, notified });
    // Dispatch happens on the cron sweep; this just gets them moving sooner.
    ctx.waitUntil(
      import('./notify')
        .then((m) => m.dispatchOutbox(ctx.db, ctx.email, Math.min(notified, 25)))
        .catch((err) => log.warn('stock_alerts.dispatch_failed', { error: errMessage(err) })),
    );
  }

  return { notified };
}

/** Record a request. Returns false when the variant is already buyable. */
export async function requestAlert(ctx: AppContext, variantId: string, email: string): Promise<boolean> {
  await ctx.db.run(
    `INSERT INTO stock_alerts (id, variant_id, email, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (variant_id, email) DO NOTHING`,
    [newId('alr'), variantId, email.trim().toLowerCase(), Date.now()],
  );
  return true;
}

/** Everyone currently waiting, for the admin view. */
export async function waitingSummary(
  ctx: AppContext,
): Promise<{ variantId: string; sku: string; label: string; waiting: number; available: number }[]> {
  return ctx.db.all<{ variantId: string; sku: string; label: string; waiting: number; available: number }>(
    `SELECT a.variant_id AS variantId, v.sku,
            p.name || ' ' || v.name AS label,
            COUNT(*) AS waiting,
            COALESCE(i.on_hand - i.reserved, 0) AS available
       FROM stock_alerts a
       JOIN product_variants v ON v.id = a.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN inventory i ON i.variant_id = a.variant_id
      WHERE a.notified_at IS NULL
      GROUP BY a.variant_id
      ORDER BY waiting DESC`,
  );
}
