/**
 * Notifications: the durable email outbox and in-app notifications.
 *
 * Every email is INSERTed into `email_outbox` before the provider is touched.
 * That ordering is the whole design: an order confirmation that exists as a row
 * can be retried, inspected and resent, whereas one that only ever existed as an
 * in-flight fetch is gone the moment the provider 500s. It also means the mock
 * provider is genuinely useful — the outbox is a readable inbox.
 *
 * Dispatch runs inside `waitUntil` so the customer's request returns as soon as
 * their order is durable, and a cron sweep retries whatever failed.
 */

import type { AppContext } from '../context';
import type { Db } from '../db/client';
import { parseJson } from '../db/client';
import type { EmailOutboxRow, NotificationRow } from '../db/types';
import { optionalEnv, storeName, supportEmail } from '../env';
import { newId } from '../ids';
import { errMessage, log, maskEmail } from '../log';
import type { EmailProvider, OutgoingEmail } from '../providers/email/types';

export interface QueueEmailInput {
  to: string;
  toName?: string;
  subject: string;
  template: string;
  text: string;
  html: string;
  data?: Record<string, unknown>;
  userId?: string | null;
  orderId?: string | null;
  /**
   * Collapses duplicates. An order confirmation uses `order_confirmation:<id>`
   * so a retried webhook cannot mail the customer their receipt twice.
   */
  idempotencyKey?: string | null;
  replyTo?: string | null;
  /** Delay delivery — used for the post-delivery review request. */
  scheduledAt?: number;
}

/** Insert into the outbox. Returns the row id, or null if it was a duplicate. */
export async function queueEmail(ctx: AppContext, input: QueueEmailInput): Promise<string | null> {
  const now = Date.now();
  const to = input.to.trim().toLowerCase();

  const suppressed = await ctx.db.first<{ email: string }>('SELECT email FROM email_suppressions WHERE email = ?', [
    to,
  ]);

  const id = newId('eml');
  const fromEmail = optionalEnv(ctx.env, 'EMAIL_FROM', supportEmail(ctx.env));
  const fromName = optionalEnv(ctx.env, 'EMAIL_FROM_NAME', storeName(ctx.env));

  try {
    await ctx.db.run(
      `INSERT INTO email_outbox (id, to_email, to_name, from_email, from_name, reply_to, subject, template,
                                 text_body, html_body, data_json, status, attempts, max_attempts,
                                 user_id, order_id, idempotency_key, scheduled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 5, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        to,
        input.toName ?? '',
        fromEmail,
        fromName,
        input.replyTo ?? supportEmail(ctx.env),
        input.subject,
        input.template,
        input.text,
        input.html,
        JSON.stringify(input.data ?? {}),
        suppressed ? 'suppressed' : 'queued',
        input.userId ?? null,
        input.orderId ?? null,
        input.idempotencyKey ?? null,
        input.scheduledAt ?? now,
        now,
        now,
      ],
    );
  } catch (err) {
    // A UNIQUE violation on idempotency_key means this exact email is already
    // queued or sent. That is success, not failure.
    const message = errMessage(err);
    if (message.includes('UNIQUE') || message.includes('constraint')) {
      log.info('email.duplicate_suppressed', { template: input.template, idempotencyKey: input.idempotencyKey });
      return null;
    }
    throw err;
  }

  if (suppressed) {
    log.warn('email.suppressed', { to: maskEmail(to), template: input.template });
    return id;
  }

  log.info('email.queued', { emailId: id, to: maskEmail(to), template: input.template });
  return id;
}

/** Queue an email and hand it to the provider without blocking the response. */
export async function queueAndSend(ctx: AppContext, input: QueueEmailInput): Promise<void> {
  const id = await queueEmail(ctx, input);
  if (!id) return;
  ctx.waitUntil(dispatchOne(ctx.db, ctx.email, id).catch((err) => log.error('email.dispatch_failed', { emailId: id, error: errMessage(err) })));
}

/** Backoff between attempts: 1, 2, 4, 8, 16 minutes, capped at an hour. */
function retryDelayMs(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts - 1) * 60_000, 60 * 60 * 1000);
}

/**
 * Send one queued row.
 *
 * The claim is a conditional UPDATE from `queued`/`failed` to `sending`; if it
 * changes no row, another invocation already has it and this one returns. That
 * is what keeps a cron sweep from racing an inline `waitUntil` dispatch and
 * mailing the customer twice.
 */
export async function dispatchOne(db: Db, provider: EmailProvider, emailId: string): Promise<boolean> {
  const now = Date.now();

  const claimed = await db.run(
    `UPDATE email_outbox
        SET status = 'sending', attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND status IN ('queued','failed') AND scheduled_at <= ?`,
    [now, emailId, now],
  );
  if (claimed === 0) return false;

  const row = await db.first<EmailOutboxRow>('SELECT * FROM email_outbox WHERE id = ?', [emailId]);
  if (!row) return false;

  const message: OutgoingEmail = {
    to: { email: row.to_email, name: row.to_name || undefined },
    from: { email: row.from_email, name: row.from_name || undefined },
    replyTo: row.reply_to ?? undefined,
    subject: row.subject,
    text: row.text_body,
    html: row.html_body,
    template: row.template,
    data: parseJson<Record<string, unknown>>(row.data_json, {}),
    idempotencyKey: row.idempotency_key ?? row.id,
  };

  try {
    const result = await provider.send(message);
    await db.run(
      `UPDATE email_outbox SET status = 'sent', sent_at = ?, provider = ?, provider_message_id = ?,
              last_error = NULL, updated_at = ? WHERE id = ?`,
      [Date.now(), result.provider, result.providerMessageId, Date.now(), emailId],
    );
    return true;
  } catch (err) {
    const error = errMessage(err).slice(0, 500);
    const exhausted = row.attempts >= row.max_attempts;
    await db.run(
      `UPDATE email_outbox SET status = 'failed', last_error = ?, scheduled_at = ?, updated_at = ? WHERE id = ?`,
      [error, exhausted ? Date.now() + 24 * 60 * 60 * 1000 : Date.now() + retryDelayMs(row.attempts), Date.now(), emailId],
    );
    if (exhausted) {
      log.alert('email.giving_up', {
        emailId,
        to: maskEmail(row.to_email),
        template: row.template,
        attempts: row.attempts,
        error,
      });
    } else {
      log.warn('email.send_failed_will_retry', { emailId, attempts: row.attempts, error });
    }
    return false;
  }
}

/** Drain due outbox rows. Called by the cron endpoint. */
export async function dispatchOutbox(db: Db, provider: EmailProvider, limit = 25): Promise<{ sent: number; failed: number }> {
  const now = Date.now();
  const due = await db.all<{ id: string }>(
    `SELECT id FROM email_outbox
      WHERE status IN ('queued','failed') AND scheduled_at <= ? AND attempts < max_attempts
      ORDER BY scheduled_at ASC LIMIT ?`,
    [now, limit],
  );

  let sent = 0;
  let failed = 0;
  for (const row of due) {
    // Sequential rather than parallel: a provider rate limit hit by 25 concurrent
    // sends turns a transient blip into 25 failures with escalating backoff.
    const ok = await dispatchOne(db, provider, row.id);
    if (ok) sent += 1;
    else failed += 1;
  }
  if (due.length > 0) log.info('email.outbox_drained', { considered: due.length, sent, failed });
  return { sent, failed };
}

export async function suppressEmail(db: Db, email: string, reason: string, source = 'manual'): Promise<void> {
  await db.run(
    `INSERT INTO email_suppressions (email, reason, source, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET reason = excluded.reason, source = excluded.source`,
    [email.trim().toLowerCase(), reason, source, Date.now()],
  );
  log.warn('email.suppression_added', { email: maskEmail(email), reason });
}

// ─── In-app notifications ────────────────────────────────────────────────────

export interface NotifyInput {
  userId: string;
  type: string;
  title: string;
  body?: string;
  link?: string | null;
  data?: Record<string, unknown>;
}

export async function notify(db: Db, input: NotifyInput): Promise<string> {
  const id = newId('ntf');
  await db.run(
    `INSERT INTO notifications (id, user_id, type, title, body, link, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.userId, input.type, input.title, input.body ?? '', input.link ?? null, JSON.stringify(input.data ?? {}), Date.now()],
  );
  return id;
}

export async function listNotifications(
  db: Db,
  userId: string,
  opts: { limit?: number; unreadOnly?: boolean } = {},
): Promise<NotificationRow[]> {
  const limit = Math.min(opts.limit ?? 30, 100);
  return db.all<NotificationRow>(
    opts.unreadOnly
      ? 'SELECT * FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [userId, limit],
  );
}

export async function countUnread(db: Db, userId: string): Promise<number> {
  return (await db.scalar<number>('SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL', [userId])) ?? 0;
}

export async function markNotificationsRead(db: Db, userId: string, ids?: string[]): Promise<number> {
  const now = Date.now();
  if (!ids || ids.length === 0) {
    return db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [now, userId]);
  }
  return db.run(
    `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(', ')})`,
    [now, userId, ...ids],
  );
}
