/**
 * Accounts: registration, sign-in, email verification, password reset, profile
 * and the saved address book.
 *
 * Two rules run through all of it:
 *
 *  1. Nothing here reveals whether an email address is registered. Sign-in
 *     failures are one message, password-reset requests always report success,
 *     and registration against an existing address sends a "someone tried to
 *     sign up as you" mail instead of erroring. Otherwise the forms become an
 *     account-enumeration oracle for anyone who wants a list of our customers.
 *  2. Single-use links are stored hashed and consumed atomically, so a leaked
 *     database cannot be turned into a password reset.
 */

import type { Db } from '../db/client';
import type { AddressRow, AuthTokenRow, TokenPurpose, UserRow } from '../db/types';
import { badRequest, conflict, notFound, unauthorized } from '../errors';
import { hashPassword, sha256Hex, verifyPassword } from '../crypto';
import { newId, newToken } from '../ids';
import { log, maskEmail } from '../log';
import type { AddressInput } from '../validate';

export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
/** Guest order links stay usable for as long as a return could plausibly happen. */
export const ORDER_ACCESS_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | null> {
  return db.first<UserRow>('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
}

export async function findUserById(db: Db, id: string): Promise<UserRow | null> {
  return db.first<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
}

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
  phone?: string;
  marketingOptIn?: boolean;
}

export type RegisterOutcome =
  | { created: true; user: UserRow; verificationToken: string }
  | { created: false; existingUser: UserRow };

/**
 * Create an account.
 *
 * When the address already exists this returns `created: false` rather than
 * throwing, and the caller sends a "you already have an account" email to the
 * real owner. The HTTP response is identical either way — that is the point.
 *
 * A guest who checked out previously has a passwordless shell account; setting a
 * password on it is an upgrade, not a conflict, and it inherits their orders.
 */
export async function registerUser(db: Db, input: RegisterInput): Promise<RegisterOutcome> {
  const email = input.email.trim().toLowerCase();
  const existing = await findUserByEmail(db, email);

  if (existing && existing.password_hash !== null) {
    log.info('accounts.register_existing', { email: maskEmail(email) });
    return { created: false, existingUser: existing };
  }

  const now = Date.now();
  const passwordHash = await hashPassword(input.password);

  if (existing) {
    // Guest shell → real account. Their past orders are already keyed to this row.
    await db.run(
      `UPDATE users SET password_hash = ?, name = COALESCE(NULLIF(?, ''), name),
              phone = COALESCE(?, phone), marketing_opt_in = ?, updated_at = ?
        WHERE id = ?`,
      [passwordHash, input.name, input.phone ?? null, input.marketingOptIn ? 1 : 0, now, existing.id],
    );
    const upgraded = await findUserById(db, existing.id);
    const token = await issueToken(db, { userId: existing.id, purpose: 'email_verify', email, ttlMs: EMAIL_VERIFY_TTL_MS });
    log.info('accounts.guest_upgraded', { userId: existing.id });
    return { created: true, user: upgraded as UserRow, verificationToken: token };
  }

  const id = newId('usr');
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, phone, role, status, marketing_opt_in,
                        failed_logins, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'customer', 'active', ?, 0, ?, ?)`,
    [id, email, passwordHash, input.name, input.phone ?? null, input.marketingOptIn ? 1 : 0, now, now],
  );

  const user = (await findUserById(db, id)) as UserRow;
  const token = await issueToken(db, { userId: id, purpose: 'email_verify', email, ttlMs: EMAIL_VERIFY_TTL_MS });
  log.info('accounts.registered', { userId: id, email: maskEmail(email) });
  return { created: true, user, verificationToken: token };
}

/**
 * Create the passwordless shell account a guest checkout attaches its order to,
 * so "sign up later with the same email" inherits the order history.
 */
export async function ensureGuestUser(
  db: Db,
  email: string,
  name: string,
  phone: string | null,
): Promise<UserRow> {
  const normalised = email.trim().toLowerCase();
  const existing = await findUserByEmail(db, normalised);
  if (existing) return existing;

  const id = newId('usr');
  const now = Date.now();
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, phone, role, status, marketing_opt_in,
                        failed_logins, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, 'customer', 'active', 0, 0, ?, ?)`,
    [id, normalised, name, phone, now, now],
  );
  log.info('accounts.guest_created', { userId: id, email: maskEmail(normalised) });
  return (await findUserById(db, id)) as UserRow;
}

export interface AuthenticateResult {
  user: UserRow;
}

/**
 * Verify credentials.
 *
 * Every failure raises the same `unauthorized` with the same wording — a
 * different message for "no such account" would confirm which addresses are
 * registered. A per-account lockout backs up the per-IP rate limit so that a
 * distributed attack on one account still stalls.
 */
export async function authenticate(db: Db, email: string, password: string): Promise<AuthenticateResult> {
  const generic = () => unauthorized('That email and password do not match. Please try again.');
  const user = await findUserByEmail(db, email);
  const now = Date.now();

  if (!user) {
    // Burn comparable CPU so response time does not reveal that the account is absent.
    await verifyPassword(password, null);
    throw generic();
  }
  if (user.status !== 'active') {
    await verifyPassword(password, null);
    throw generic();
  }
  if (user.locked_until !== null && user.locked_until > now) {
    const minutes = Math.ceil((user.locked_until - now) / 60000);
    throw unauthorized(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }

  const { valid, needsRehash } = await verifyPassword(password, user.password_hash);
  if (!valid) {
    const failed = user.failed_logins + 1;
    const lockUntil = failed >= MAX_FAILED_LOGINS ? now + LOCKOUT_MS : null;
    await db.run('UPDATE users SET failed_logins = ?, locked_until = ?, updated_at = ? WHERE id = ?', [
      failed,
      lockUntil,
      now,
      user.id,
    ]);
    if (lockUntil) log.warn('accounts.locked_out', { userId: user.id, failed });
    throw generic();
  }

  // Successful login clears the counter and, if the stored hash predates a
  // raised iteration count, silently upgrades it.
  const nextHash = needsRehash ? await hashPassword(password) : null;
  await db.run(
    `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ?, updated_at = ?
            ${nextHash ? ', password_hash = ?' : ''}
      WHERE id = ?`,
    nextHash ? [now, now, nextHash, user.id] : [now, now, user.id],
  );
  if (nextHash) log.info('accounts.password_rehashed', { userId: user.id });

  return { user: { ...user, password_hash: nextHash ?? user.password_hash } };
}

// ─── Single-use tokens ───────────────────────────────────────────────────────

export interface IssueTokenInput {
  userId: string | null;
  purpose: TokenPurpose;
  email?: string | null;
  orderId?: string | null;
  ttlMs: number;
}

/** Returns the RAW token — the caller emails it; only the hash is stored. */
export async function issueToken(db: Db, input: IssueTokenInput): Promise<string> {
  const raw = newToken(32);
  const now = Date.now();

  // One live token per purpose per user: requesting a second reset link must
  // invalidate the first, or an intercepted older email stays usable.
  if (input.userId) {
    await db.run(
      'UPDATE auth_tokens SET consumed_at = ? WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL',
      [now, input.userId, input.purpose],
    );
  }

  await db.run(
    `INSERT INTO auth_tokens (id, token_hash, user_id, purpose, email, order_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('tok'),
      await sha256Hex(raw),
      input.userId,
      input.purpose,
      input.email ?? null,
      input.orderId ?? null,
      now + input.ttlMs,
      now,
    ],
  );
  return raw;
}

/**
 * Consume a token, atomically. The UPDATE's WHERE clause is the check, so two
 * simultaneous clicks on the same reset link cannot both succeed.
 */
export async function consumeToken(db: Db, raw: string, purpose: TokenPurpose): Promise<AuthTokenRow> {
  const hash = await sha256Hex(raw);
  const now = Date.now();

  const row = await db.first<AuthTokenRow>(
    `UPDATE auth_tokens SET consumed_at = ?
      WHERE token_hash = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?
      RETURNING *`,
    [now, hash, purpose, now],
  );

  if (!row) {
    log.info('accounts.token_rejected', { purpose });
    throw badRequest('That link has expired or has already been used. Please request a new one.');
  }
  return row;
}

/** Read a token without consuming it — for showing a form before the POST. */
export async function peekToken(db: Db, raw: string, purpose: TokenPurpose): Promise<AuthTokenRow | null> {
  const hash = await sha256Hex(raw);
  return db.first<AuthTokenRow>(
    'SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?',
    [hash, purpose, Date.now()],
  );
}

export async function markEmailVerified(db: Db, userId: string): Promise<void> {
  const now = Date.now();
  await db.run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?', [
    now,
    now,
    userId,
  ]);
}

export async function setPassword(db: Db, userId: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  const now = Date.now();
  await db.run(
    'UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
    [hash, now, userId],
  );
  log.info('accounts.password_set', { userId });
}

export async function updateProfile(
  db: Db,
  userId: string,
  patch: { name?: string; phone?: string; marketingOptIn?: boolean },
): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.phone !== undefined) {
    sets.push('phone = ?');
    params.push(patch.phone);
  }
  if (patch.marketingOptIn !== undefined) {
    sets.push('marketing_opt_in = ?');
    params.push(patch.marketingOptIn ? 1 : 0);
  }
  if (sets.length === 0) return;

  sets.push('updated_at = ?');
  params.push(Date.now(), userId);
  await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
}

// ─── Address book ────────────────────────────────────────────────────────────

export async function listAddresses(db: Db, userId: string): Promise<AddressRow[]> {
  return db.all<AddressRow>(
    `SELECT * FROM addresses WHERE user_id = ? AND deleted_at IS NULL
      ORDER BY is_default_shipping DESC, updated_at DESC`,
    [userId],
  );
}

export async function getAddress(db: Db, userId: string, addressId: string): Promise<AddressRow> {
  const row = await db.first<AddressRow>(
    'SELECT * FROM addresses WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    [addressId, userId],
  );
  if (!row) throw notFound('That address is not on your account.');
  return row;
}

export async function saveAddress(
  db: Db,
  userId: string,
  input: AddressInput,
  opts: { addressId?: string; makeDefault?: boolean } = {},
): Promise<string> {
  const now = Date.now();
  const existingCount = await db.scalar<number>(
    'SELECT COUNT(*) FROM addresses WHERE user_id = ? AND deleted_at IS NULL',
    [userId],
  );
  // The first address a customer saves is their default whether they asked or not.
  const makeDefault = opts.makeDefault || (existingCount ?? 0) === 0;

  const id = opts.addressId ?? newId('adr');
  const params = [
    input.label ?? 'Home',
    input.full_name,
    input.phone,
    input.line1,
    input.line2 ?? null,
    input.landmark ?? null,
    input.city,
    input.state,
    input.pincode,
    input.country ?? 'IN',
    now,
  ];

  if (opts.addressId) {
    const changed = await db.run(
      `UPDATE addresses SET label = ?, full_name = ?, phone = ?, line1 = ?, line2 = ?, landmark = ?,
              city = ?, state = ?, pincode = ?, country = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      [...params, opts.addressId, userId],
    );
    if (changed === 0) throw notFound('That address is not on your account.');
  } else {
    if ((existingCount ?? 0) >= 20) throw conflict('You can save up to 20 addresses.');
    await db.run(
      `INSERT INTO addresses (id, user_id, label, full_name, phone, line1, line2, landmark, city, state,
                              pincode, country, is_default_shipping, is_default_billing, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [id, userId, ...params.slice(0, 10), now, now],
    );
  }

  if (makeDefault) await setDefaultAddress(db, userId, id);
  return id;
}

export async function setDefaultAddress(db: Db, userId: string, addressId: string): Promise<void> {
  const now = Date.now();
  // Both statements in one batch so there is never a moment with two defaults
  // (or none) visible to a concurrent checkout.
  await db.batch([
    db.stmt(
      'UPDATE addresses SET is_default_shipping = 0, is_default_billing = 0, updated_at = ? WHERE user_id = ?',
      [now, userId],
    ),
    db.stmt(
      'UPDATE addresses SET is_default_shipping = 1, is_default_billing = 1, updated_at = ? WHERE id = ? AND user_id = ?',
      [now, addressId, userId],
    ),
  ]);
}

/**
 * Soft delete. Orders snapshot their address at placement, so removing one here
 * never rewrites a past order's delivery address.
 */
export async function deleteAddress(db: Db, userId: string, addressId: string): Promise<void> {
  const now = Date.now();
  const changed = await db.run(
    'UPDATE addresses SET deleted_at = ?, is_default_shipping = 0, is_default_billing = 0 WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    [now, addressId, userId],
  );
  if (changed === 0) throw notFound('That address is not on your account.');

  // Promote the next-most-recent address so the customer is never left without
  // a default at checkout.
  const remaining = await db.first<AddressRow>(
    'SELECT * FROM addresses WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1',
    [userId],
  );
  if (remaining) await setDefaultAddress(db, userId, remaining.id);
}

export async function pruneExpiredTokens(db: Db): Promise<number> {
  return db.run('DELETE FROM auth_tokens WHERE expires_at < ?', [Date.now() - 7 * 24 * 60 * 60 * 1000]);
}
