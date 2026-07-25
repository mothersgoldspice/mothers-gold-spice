/**
 * Writing a review. The customer half of the feature.
 *
 * Verified purchase only, and only for a signed-in customer. Social proof on
 * food is worthless if anyone can write it, and an open review box on a shop
 * with no moderation staff is a spam magnet that costs more to clean out than
 * the reviews are worth. So the gate is the strongest one we hold: an order of
 * YOURS, containing THIS product, that we actually delivered. Anonymous reviews
 * are refused outright rather than accepted and quietly buried in the queue.
 *
 * Everything lands as `pending`. Nothing a customer types appears on the
 * storefront until a person has read it — /admin/reviews is that queue.
 */

import type { APIRoute } from 'astro';
import { rateKey, requireUser } from '../../lib/api';
import { conflict, forbidden, notFound } from '../../lib/errors';
import { created, handle, readJson } from '../../lib/http';
import { newId } from '../../lib/ids';
import { log } from '../../lib/log';
import { RATE_LIMITS, enforceRateLimit } from '../../lib/rate-limit';
import { parseOrThrow, reviewSchema } from '../../lib/validate';

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireUser(locals);
    const input = parseOrThrow(reviewSchema, await readJson(request));

    // The same ceiling as the other public write forms. A verified buyer has no
    // reason to file five reviews in an hour, so this costs an honest customer
    // nothing and caps the damage if an account is ever taken over.
    await enforceRateLimit(ctx.db, rateKey(ctx, 'review'), RATE_LIMITS.contact);

    const product = await ctx.db.first<{ id: string; name: string }>(
      'SELECT id, name FROM products WHERE id = ?',
      [input.product_id],
    );
    if (!product) throw notFound('We could not find that product.');

    /*
     * The verification itself.
     *
     * `delivered` and nothing else. A parcel still in transit has not been
     * tasted; `cancelled` never shipped; `returned` and `refunded` mean the jar
     * came back, and a review from someone we refunded is not a purchase we
     * would vouch for. The order id is stored on the review so a moderator can
     * see the receipt behind it months later.
     */
    const order = await ctx.db.first<{ id: string; customer_name: string }>(
      `SELECT o.id, o.customer_name
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
        WHERE o.user_id = ? AND oi.product_id = ? AND o.status = 'delivered'
        ORDER BY o.delivered_at DESC, o.created_at DESC
        LIMIT 1`,
      [user.id, product.id],
    );
    if (!order) {
      throw forbidden(
        `Reviews are open to customers we have delivered ${product.name} to. If your order has just arrived, give the tracking a day to catch up.`,
      );
    }

    // `users.name` defaults to empty and a guest shell may never have been given
    // one, so the checkout name is the fallback before the generic label.
    const authorName = user.name.trim() || order.customer_name.trim() || 'A verified customer';

    const now = Date.now();
    const id = newId('rev');

    /*
     * One review per customer per product, enforced inside the INSERT.
     *
     * There is no unique index on (product_id, user_id), so there is no
     * ON CONFLICT to lean on — and a SELECT-then-INSERT would let two taps of a
     * submit button write two rows. `SELECT ... WHERE NOT EXISTS` settles it in
     * one statement: zero rows written means the guard fired.
     */
    const written = await ctx.db.run(
      `INSERT INTO product_reviews
         (id, product_id, order_id, user_id, author_name, rating, title, body, status, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM product_reviews WHERE product_id = ? AND user_id = ?)`,
      [
        id,
        product.id,
        order.id,
        user.id,
        authorName,
        input.rating,
        input.title,
        input.body,
        now,
        now,
        product.id,
        user.id,
      ],
    );

    if (written === 0) {
      throw conflict(
        `You have already written about ${product.name}. Write to us if you would like to change what you said.`,
      );
    }

    log.info('review.submitted', {
      reviewId: id,
      productId: product.id,
      orderId: order.id,
      userId: user.id,
      rating: input.rating,
    });

    return created({
      id,
      productId: product.id,
      rating: input.rating,
      status: 'pending' as const,
      createdAt: now,
    });
  });
