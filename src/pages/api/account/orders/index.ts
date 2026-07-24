/**
 * The customer's order history.
 *
 * A list row carries only what the card on the account page draws — number,
 * status, total, and the first item as a thumbnail. The internals that live on
 * an order row (the guest access hash, the checkout idempotency key, the cart it
 * came from) are operational plumbing and are never serialised.
 */

import type { APIRoute } from 'astro';
import { readPaging, requireUser } from '../../../../lib/api';
import { handle, ok } from '../../../../lib/http';
import { STATUS_LABEL, listOrdersForUser } from '../../../../lib/services/orders';

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) =>
  handle(async () => {
    // The user id comes from the session. An `?user=` parameter would make this
    // a reader for anybody's order history.
    const { ctx, user } = requireUser(locals);
    const { limit, offset } = readPaging(url, 10, 50);

    const rows = await listOrdersForUser(ctx.db, user.id, limit, offset);
    const total = (await ctx.db.scalar<number>('SELECT COUNT(*) FROM orders WHERE user_id = ?', [user.id])) ?? 0;

    return ok({
      items: rows.map((row) => ({
        id: row.order.id,
        orderNumber: row.order.order_number,
        status: row.order.status,
        // Sent rendered so the wording of a status lives in one place rather
        // than being reimplemented in every client that lists orders.
        statusLabel: STATUS_LABEL[row.order.status],
        paymentStatus: row.order.payment_status,
        totalPaise: row.order.total_paise,
        placedAt: row.order.placed_at,
        itemCount: row.itemCount,
        firstItemName: row.firstItemName,
        firstItemImage: row.firstItemImage,
      })),
      total,
      limit,
      offset,
    });
  });
