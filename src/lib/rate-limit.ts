/**
 * Fixed-window rate limiting backed by D1.
 *
 * D1 rather than KV because the counters must be read-your-own-write consistent:
 * KV's eventual consistency would let a burst of login attempts all read a stale
 * zero. A fixed window is coarse at the boundary but is one row and one
 * statement, which matters on the login path.
 *
 * Every limiter call is best-effort with respect to infrastructure failure: if
 * the counter table is unavailable we allow the request rather than take the
 * storefront down, and log it.
 */

import type { Db } from './db/client';
import { rateLimited } from './errors';
import { log } from './log';

export interface RateLimitRule {
  /** Maximum requests inside the window. */
  limit: number;
  windowMs: number;
}

export const RATE_LIMITS = {
  login: { limit: 8, windowMs: 15 * 60 * 1000 },
  register: { limit: 5, windowMs: 60 * 60 * 1000 },
  passwordReset: { limit: 4, windowMs: 60 * 60 * 1000 },
  checkout: { limit: 20, windowMs: 10 * 60 * 1000 },
  cartWrite: { limit: 120, windowMs: 5 * 60 * 1000 },
  pincodeLookup: { limit: 60, windowMs: 5 * 60 * 1000 },
  contact: { limit: 5, windowMs: 60 * 60 * 1000 },
  guestTrack: { limit: 30, windowMs: 10 * 60 * 1000 },
} as const satisfies Record<string, RateLimitRule>;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export async function checkRateLimit(db: Db, key: string, rule: RateLimitRule): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs;
  const expiresAt = windowStart + rule.windowMs;
  const rowKey = `${key}:${windowStart}`;

  try {
    // One statement: insert the window at 1, or bump the existing counter.
    // RETURNING gives us the post-increment value without a second read.
    const row = await db.first<{ count: number }>(
      `INSERT INTO rate_limits (key, count, window_start, expires_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT (key) DO UPDATE SET count = rate_limits.count + 1
       RETURNING count`,
      [rowKey, windowStart, expiresAt],
    );

    const count = row?.count ?? 1;
    return { allowed: count <= rule.limit, remaining: Math.max(0, rule.limit - count), resetAt: expiresAt };
  } catch (err) {
    log.error('rate_limit.storage_error', { key, error: err instanceof Error ? err.message : String(err) });
    return { allowed: true, remaining: rule.limit, resetAt: expiresAt };
  }
}

/** Throw a 429 when the limit is exceeded. */
export async function enforceRateLimit(db: Db, key: string, rule: RateLimitRule): Promise<void> {
  const result = await checkRateLimit(db, key, rule);
  if (!result.allowed) {
    const seconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    log.warn('rate_limit.exceeded', { key, retryAfterSeconds: seconds });
    throw rateLimited(
      `Too many attempts. Please try again in ${seconds > 60 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`}.`,
    );
  }
}

export async function pruneRateLimits(db: Db): Promise<number> {
  return db.run('DELETE FROM rate_limits WHERE expires_at < ?', [Date.now()]);
}
