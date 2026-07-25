/**
 * Review moderation. The staff half of the feature.
 *
 * Nothing a customer writes is public until a row here is set to `approved`, so
 * this route is the only thing standing between the storefront and whatever
 * somebody typed after a bad day. It reports the receipt alongside the text —
 * which order the review came from and whether that order really reached
 * `delivered` — because "is this person actually a customer" is the first
 * question a moderator asks and it should not need a second screen to answer.
 *
 * Approve and reject are the only two moves, and both are reversible: a review
 * rejected by mistake can be approved later, and vice versa.
 */

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { readPaging, requireAdmin } from '../../../lib/api';
import { notFound } from '../../../lib/errors';
import { handle, ok, readJson } from '../../../lib/http';
import { newId } from '../../../lib/ids';
import { log } from '../../../lib/log';
import { parseOrThrow } from '../../../lib/validate';

export const prerender = false;

const STATUSES = ['pending', 'approved', 'rejected'] as const;
type ReviewStatus = (typeof STATUSES)[number];

const filterSchema = z.object({
  status: z.enum(STATUSES).nullable().optional(),
});

interface AdminReviewRow {
  id: string;
  product_id: string;
  order_id: string | null;
  user_id: string | null;
  author_name: string;
  rating: number;
  title: string;
  body: string;
  status: ReviewStatus;
  created_at: number;
  updated_at: number;
  product_name: string;
  product_slug: string;
  user_name: string | null;
  user_email: string | null;
  order_number: string | null;
  order_status: string | null;
  delivered_at: number | null;
}

/*
 * Pending first, then newest.
 *
 * A moderation queue sorted purely by date buries the one thing it exists for
 * under six months of decisions that have already been made.
 */
const QUEUE_ORDER =
  "CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, r.created_at DESC";

export const GET: APIRoute = async ({ locals, url }) =>
  handle(async () => {
    const { ctx } = requireAdmin(locals);

    const { limit, offset } = readPaging(url, 25, 100);
    const filters = parseOrThrow(filterSchema, { status: url.searchParams.get('status') || null });

    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filters.status) {
      where.push('r.status = ?');
      params.push(filters.status);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const [total, rows, tallies] = await Promise.all([
      ctx.db.scalar<number>(`SELECT COUNT(*) FROM product_reviews r ${clause}`, params),
      // LEFT JOIN on users and orders: a user deleted since writing leaves
      // user_id NULL by design, and dropping their review off the queue would
      // leave it stuck at pending forever with nobody able to see it.
      ctx.db.all<AdminReviewRow>(
        `SELECT r.id, r.product_id, r.order_id, r.user_id, r.author_name, r.rating, r.title, r.body,
                r.status, r.created_at, r.updated_at,
                p.name AS product_name, p.slug AS product_slug,
                u.name AS user_name, u.email AS user_email,
                o.order_number, o.status AS order_status, o.delivered_at
           FROM product_reviews r
           JOIN products p ON p.id = r.product_id
           LEFT JOIN users u ON u.id = r.user_id
           LEFT JOIN orders o ON o.id = r.order_id
           ${clause}
          ORDER BY ${QUEUE_ORDER}
          LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      // Unfiltered on purpose: the tallies are how a moderator decides which
      // filter to switch to, so they must not move when the filter does.
      ctx.db.all<{ status: ReviewStatus; n: number }>(
        'SELECT status, COUNT(*) AS n FROM product_reviews GROUP BY status',
      ),
    ]);

    const counts: Record<ReviewStatus, number> = { pending: 0, approved: 0, rejected: 0 };
    for (const row of tallies) counts[row.status] = row.n;

    return ok({
      items: rows.map((r) => ({
        id: r.id,
        productId: r.product_id,
        productName: r.product_name,
        productSlug: r.product_slug,
        orderId: r.order_id,
        orderNumber: r.order_number,
        orderStatus: r.order_status,
        // The claim the whole feature rests on, restated as a plain boolean so a
        // caller cannot get the status comparison subtly wrong.
        purchaseVerified: r.order_status === 'delivered',
        deliveredAt: r.delivered_at,
        userId: r.user_id,
        authorName: r.author_name,
        reviewerName: r.user_name,
        reviewerEmail: r.user_email,
        rating: r.rating,
        title: r.title,
        body: r.body,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      counts,
      total: total ?? 0,
      limit,
      offset,
      hasMore: offset + rows.length < (total ?? 0),
    });
  });

const moderateSchema = z
  .object({
    id: z.string().trim().min(1, 'Choose a review.'),
    // `pending` is absent deliberately: it is where a review starts, not
    // somewhere a moderator sends one. Every decision here is a decision.
    status: z.enum(['approved', 'rejected'], {
      errorMap: () => ({ message: 'A review is either approved or rejected.' }),
    }),
  })
  .strict();

export const PATCH: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireAdmin(locals);
    const input = parseOrThrow(moderateSchema, await readJson<Record<string, unknown>>(request));

    const review = await ctx.db.first<{
      id: string;
      product_id: string;
      status: ReviewStatus;
      rating: number;
      author_name: string;
      product_name: string;
    }>(
      `SELECT r.id, r.product_id, r.status, r.rating, r.author_name, p.name AS product_name
         FROM product_reviews r
         JOIN products p ON p.id = r.product_id
        WHERE r.id = ?`,
      [input.id],
    );
    if (!review) throw notFound('We could not find that review.');

    // A double-tap on Approve is not a second decision. Answering it happily
    // and writing nothing keeps the audit trail a record of what changed rather
    // than of how many times somebody clicked.
    if (review.status === input.status) {
      return ok({ id: review.id, status: review.status, changed: false });
    }

    const now = Date.now();
    await ctx.db.run('UPDATE product_reviews SET status = ?, updated_at = ? WHERE id = ?', [
      input.status,
      now,
      review.id,
    ]);

    await ctx.db.run(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, data_json, ip, created_at)
       VALUES (?, 'admin', ?, ?, 'review', ?, ?, ?, ?)`,
      [
        newId('aud'),
        user.id,
        input.status === 'approved' ? 'review.approve' : 'review.reject',
        review.id,
        JSON.stringify({
          from: review.status,
          to: input.status,
          productId: review.product_id,
          productName: review.product_name,
          rating: review.rating,
          authorName: review.author_name,
        }),
        ctx.clientIp,
        now,
      ],
    );

    log.info('admin.review_moderated', {
      reviewId: review.id,
      actorId: user.id,
      from: review.status,
      to: input.status,
    });

    return ok({ id: review.id, status: input.status, changed: true, updatedAt: now });
  });
