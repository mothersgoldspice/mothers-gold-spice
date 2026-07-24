/**
 * Session lifecycle.
 *
 * The cookie carries a 256-bit random token; the database stores only its
 * SHA-256. A dump of `sessions` therefore contains nothing replayable. Sessions
 * are rotated (old row revoked, new token issued) whenever the trust level
 * changes — sign-in, password change — so a token captured before login cannot
 * be used after it.
 */

import type { AstroCookies } from 'astro';
import type { SessionUser } from '../context';
import { sha256Hex } from '../crypto';
import type { Db } from '../db/client';
import type { SessionRow, UserRow } from '../db/types';
import type { Env } from '../env';
import { newToken } from '../ids';
import { log } from '../log';
import { SESSION_COOKIE, SESSION_TTL_MS, clearCookie, setCookie } from './cookies';

export interface CreateSessionInput {
  userId: string;
  ip: string;
  userAgent: string;
}

/** Issue a new session and return the raw token for the cookie. */
export async function createSession(db: Db, input: CreateSessionInput): Promise<{ token: string; expiresAt: number }> {
  const token = newToken(32);
  const id = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  await db.run(
    `INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.userId, now, now, expiresAt, input.ip, input.userAgent.slice(0, 300)],
  );

  return { token, expiresAt };
}

export interface ResolvedSession {
  sessionId: string;
  user: SessionUser;
}

/**
 * Look up the session behind a cookie value. Returns null for missing, expired,
 * revoked, or disabled-user sessions — all of which mean "treat as anonymous".
 */
export async function resolveSession(db: Db, rawToken: string): Promise<ResolvedSession | null> {
  const id = await sha256Hex(rawToken);
  const now = Date.now();

  const row = await db.first<SessionRow & Pick<UserRow, 'email' | 'name' | 'role' | 'status' | 'email_verified_at'>>(
    `SELECT s.*, u.email, u.name, u.role, u.status, u.email_verified_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
    [id],
  );

  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at <= now) return null;
  if (row.status !== 'active') {
    log.info('auth.session.rejected_disabled_user', { userId: row.user_id });
    return null;
  }

  // Touch at most once an hour — writing on every request would turn each page
  // view into a D1 write for no benefit.
  if (now - row.last_seen_at > 60 * 60 * 1000) {
    await db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [now, id]);
  }

  return {
    sessionId: id,
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      role: row.role,
      emailVerified: row.email_verified_at !== null,
    },
  };
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [Date.now(), sessionId]);
}

/** Sign every device out — used after a password reset. */
export async function revokeAllSessions(db: Db, userId: string, exceptSessionId?: string): Promise<number> {
  const now = Date.now();
  if (exceptSessionId) {
    return db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL', [
      now,
      userId,
      exceptSessionId,
    ]);
  }
  return db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now, userId]);
}

/** Issue a session and attach the cookie. */
export async function startSession(
  db: Db,
  cookies: AstroCookies,
  env: Env,
  input: CreateSessionInput,
): Promise<string> {
  const { token } = await createSession(db, input);
  setCookie(cookies, env, SESSION_COOKIE, token, SESSION_TTL_MS);
  return token;
}

export async function endSession(db: Db, cookies: AstroCookies, env: Env, sessionId: string | null): Promise<void> {
  if (sessionId) await revokeSession(db, sessionId);
  clearCookie(cookies, env, SESSION_COOKIE);
}

/** Delete expired rows. Called by the maintenance endpoint, not per request. */
export async function pruneExpiredSessions(db: Db): Promise<number> {
  return db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now() - 7 * 24 * 60 * 60 * 1000]);
}
