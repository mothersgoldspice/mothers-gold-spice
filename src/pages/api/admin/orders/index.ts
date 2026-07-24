/**
 * Admin order list.
 *
 * Read-only, and deliberately thin: every filter is validated against a closed
 * set before it reaches `listOrders`, which builds its WHERE clause by
 * concatenation. A status that is not a real status would otherwise travel all
 * the way to SQLite as a bound parameter that matches nothing — harmless, but a
 * silently empty list is a worse answer than "that is not a status".
 *
 * The dashboard totals come back on the same response because the list page
 * shows both, and two round trips on a slow phone connection is one too many.
 */

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { readPaging, requireAdmin } from '../../../../lib/api';
import { handle, ok } from '../../../../lib/http';
import { listOrders, orderStats } from '../../../../lib/services/orders';
import { parseOrThrow } from '../../../../lib/validate';

export const prerender = false;

const filterSchema = z.object({
  status: z
    .enum([
      'pending_payment',
      'payment_failed',
      'confirmed',
      'processing',
      'packed',
      'shipped',
      'out_for_delivery',
      'delivered',
      'cancelled',
      'returned',
      'refunded',
    ])
    .nullable()
    .optional(),
  search: z.string().trim().max(120, 'That search is too long.').nullable().optional(),
});

export const GET: APIRoute = async ({ locals, url }) =>
  handle(async () => {
    const { ctx } = requireAdmin(locals);

    const { limit, offset } = readPaging(url, 25, 100);
    const filters = parseOrThrow(filterSchema, {
      status: url.searchParams.get('status') || null,
      search: url.searchParams.get('search') || null,
    });

    const [page, stats] = await Promise.all([
      listOrders(ctx.db, {
        status: filters.status ?? null,
        search: filters.search ?? null,
        limit,
        offset,
      }),
      orderStats(ctx.db),
    ]);

    return ok({
      items: page.items,
      total: page.total,
      limit,
      offset,
      hasMore: offset + page.items.length < page.total,
      stats,
    });
  });
