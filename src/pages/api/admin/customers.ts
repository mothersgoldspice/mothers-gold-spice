/**
 * The customer list.
 *
 * Order count and lifetime spend come from a single LEFT JOIN + GROUP BY rather
 * than a query per customer. At fifty customers the difference is invisible; at
 * five thousand a per-row lookup is five thousand round trips to D1 inside one
 * request, which is how an admin page that "worked fine last month" stops
 * loading at all.
 *
 * `password_hash` is never selected. Not redacted after the fact — never asked
 * for, so no future edit to the response shape can leak it by accident.
 */

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { readPaging, requireAdmin } from '../../../lib/api';
import { handle, ok } from '../../../lib/http';
import { parseOrThrow } from '../../../lib/validate';

export const prerender = false;

/** Whitelisted, because this is interpolated into the SQL rather than bound. */
const SORTS = {
  recent: 'u.created_at DESC',
  spend: 'lifetime_spend_paise DESC, u.created_at DESC',
  orders: 'order_count DESC, u.created_at DESC',
  name: 'u.name COLLATE NOCASE ASC',
} as const;

const filterSchema = z.object({
  search: z.string().trim().max(120, 'That search is too long.').nullable().optional(),
  role: z.enum(['customer', 'staff', 'admin']).nullable().optional(),
  sort: z.enum(['recent', 'spend', 'orders', 'name']).nullable().optional(),
});

interface CustomerRow {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: string;
  status: string;
  email_verified_at: number | null;
  marketing_opt_in: number;
  has_password: number;
  last_login_at: number | null;
  created_at: number;
  order_count: number;
  paid_order_count: number;
  lifetime_spend_paise: number;
  last_order_at: number | null;
}

export const GET: APIRoute = async ({ locals, url }) =>
  handle(async () => {
    const { ctx } = requireAdmin(locals);

    const { limit, offset } = readPaging(url, 25, 100);
    const filters = parseOrThrow(filterSchema, {
      search: url.searchParams.get('search') || null,
      role: url.searchParams.get('role') || null,
      sort: url.searchParams.get('sort') || null,
    });

    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filters.search) {
      const term = `%${filters.search.toLowerCase()}%`;
      where.push('(LOWER(u.email) LIKE ? OR LOWER(u.name) LIKE ? OR u.phone LIKE ?)');
      params.push(term, term, term);
    }
    if (filters.role) {
      where.push('u.role = ?');
      params.push(filters.role);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const total = (await ctx.db.scalar<number>(`SELECT COUNT(*) FROM users u ${clause}`, params)) ?? 0;

    const rows = await ctx.db.all<CustomerRow>(
      `SELECT u.id, u.email, u.name, u.phone, u.role, u.status, u.email_verified_at, u.marketing_opt_in,
              u.last_login_at, u.created_at,
              CASE WHEN u.password_hash IS NULL THEN 0 ELSE 1 END AS has_password,
              COUNT(o.id) AS order_count,
              COUNT(CASE WHEN o.payment_status IN ('paid','partially_refunded') THEN 1 END) AS paid_order_count,
              -- Lifetime spend is money we KEPT: refunds come back off the total,
              -- and an unpaid or cancelled order was never revenue in the first place.
              COALESCE(SUM(CASE WHEN o.payment_status IN ('paid','partially_refunded')
                                THEN o.total_paise - o.refunded_paise END), 0) AS lifetime_spend_paise,
              MAX(o.created_at) AS last_order_at
         FROM users u
         LEFT JOIN orders o ON o.user_id = u.id
         ${clause}
        GROUP BY u.id
        ORDER BY ${SORTS[filters.sort ?? 'recent']}
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return ok({
      items: rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        phone: r.phone,
        role: r.role,
        status: r.status,
        emailVerified: r.email_verified_at !== null,
        marketingOptIn: r.marketing_opt_in === 1,
        // A guest checkout leaves a passwordless shell so their history survives
        // them signing up later. Worth showing — it is not a broken account.
        hasAccount: r.has_password === 1,
        lastLoginAt: r.last_login_at,
        createdAt: r.created_at,
        orderCount: r.order_count,
        paidOrderCount: r.paid_order_count,
        lifetimeSpendPaise: r.lifetime_spend_paise,
        lastOrderAt: r.last_order_at,
      })),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    });
  });
