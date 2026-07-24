/**
 * The outbox, as an inbox.
 *
 * Because every email is a row before it is a send, this endpoint is the honest
 * answer to "did the customer actually get their receipt?" — including the exact
 * body they were sent, which is why `text_body` and `html_body` come back with
 * the list. Reading a rendered template from the admin screen has settled more
 * "I never received it" conversations than any provider dashboard.
 *
 * Two writes: put a row back on the queue, or stop writing to an address at all.
 */

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { readPaging, requireAdmin } from '../../../lib/api';
import type { EmailOutboxRow } from '../../../lib/db/types';
import { conflict, notFound } from '../../../lib/errors';
import { handle, ok, readJson } from '../../../lib/http';
import { newId } from '../../../lib/ids';
import { log, maskEmail } from '../../../lib/log';
import { dispatchOne, suppressEmail } from '../../../lib/services/notify';
import { emailSchema, parseOrThrow } from '../../../lib/validate';

export const prerender = false;

const filterSchema = z.object({
  status: z.enum(['queued', 'sending', 'sent', 'failed', 'suppressed', 'cancelled']).nullable().optional(),
  template: z.string().trim().max(60, 'That template name is too long.').nullable().optional(),
});

export const GET: APIRoute = async ({ locals, url }) =>
  handle(async () => {
    const { ctx } = requireAdmin(locals);

    const { limit, offset } = readPaging(url, 25, 50);
    const filters = parseOrThrow(filterSchema, {
      status: url.searchParams.get('status') || null,
      template: url.searchParams.get('template') || null,
    });

    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filters.status) {
      where.push('status = ?');
      params.push(filters.status);
    }
    if (filters.template) {
      where.push('template = ?');
      params.push(filters.template);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const total = (await ctx.db.scalar<number>(`SELECT COUNT(*) FROM email_outbox ${clause}`, params)) ?? 0;
    const items = await ctx.db.all<EmailOutboxRow>(
      `SELECT * FROM email_outbox ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    // The template list drives the filter dropdown; deriving it from the data
    // means a new template appears there the first time one is queued.
    const templates = await ctx.db.all<{ template: string; count: number }>(
      'SELECT template, COUNT(*) AS count FROM email_outbox GROUP BY template ORDER BY count DESC',
    );

    return ok({ items, total, limit, offset, hasMore: offset + items.length < total, templates });
  });

const resendSchema = z.object({
  action: z.literal('resend'),
  id: z.string().trim().min(1, 'Which email?'),
});

const suppressSchema = z
  .object({
    action: z.literal('suppress'),
    id: z.string().trim().min(1).optional().nullable(),
    email: emailSchema.optional().nullable(),
    reason: z.string().trim().min(1).max(200).optional().default('Suppressed by our team.'),
  })
  .refine((v) => Boolean(v.id ?? v.email), 'Give an outbox row or an email address to suppress.');

const actionSchema = z.object({
  action: z.enum(['resend', 'suppress'], {
    errorMap: () => ({ message: 'That is not an action we support on an email.' }),
  }),
});

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireAdmin(locals);
    const body = await readJson<Record<string, unknown>>(request);
    const { action } = parseOrThrow(actionSchema, body);

    let result: Record<string, unknown>;
    let entityId: string;

    if (action === 'resend') {
      const { id } = parseOrThrow(resendSchema, body);
      const row = await ctx.db.first<EmailOutboxRow>('SELECT * FROM email_outbox WHERE id = ?', [id]);
      if (!row) throw notFound('We could not find that email.');

      // A suppressed address is suppressed for a reason — a hard bounce or a
      // complaint. Sending again would damage the sending domain's reputation
      // for every other customer, so it takes lifting the suppression first.
      const suppressed = await ctx.db.first<{ reason: string }>(
        'SELECT reason FROM email_suppressions WHERE email = ?',
        [row.to_email],
      );
      if (suppressed) {
        throw conflict(`That address is suppressed (${suppressed.reason}). Remove the suppression before resending.`);
      }

      const now = Date.now();
      await ctx.db.run(
        `UPDATE email_outbox SET status = 'queued', attempts = 0, last_error = NULL, sent_at = NULL,
                scheduled_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, id],
      );

      // Awaited rather than deferred: the operator pressed a button and is
      // waiting to be told whether it went out.
      const sent = await dispatchOne(ctx.db, ctx.email, id);
      const fresh = await ctx.db.first<EmailOutboxRow>('SELECT * FROM email_outbox WHERE id = ?', [id]);

      entityId = id;
      result = { id, sent, status: fresh?.status ?? 'queued', lastError: fresh?.last_error ?? null };
    } else {
      const { id, email, reason } = parseOrThrow(suppressSchema, body);

      let address = email ?? null;
      if (!address && id) {
        const row = await ctx.db.first<{ to_email: string }>('SELECT to_email FROM email_outbox WHERE id = ?', [id]);
        if (!row) throw notFound('We could not find that email.');
        address = row.to_email;
      }
      if (!address) throw notFound('We could not work out which address to suppress.');

      await suppressEmail(ctx.db, address, reason, 'admin');
      // Anything still waiting to go to that address must not slip out after the
      // suppression was added.
      const cancelled = await ctx.db.run(
        `UPDATE email_outbox SET status = 'suppressed', updated_at = ?
          WHERE to_email = ? AND status IN ('queued','failed')`,
        [Date.now(), address],
      );

      entityId = address;
      result = { email: address, reason, cancelledQueued: cancelled };
    }

    await ctx.db.run(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, data_json, ip, created_at)
       VALUES (?, 'admin', ?, ?, 'email', ?, ?, ?, ?)`,
      [newId('aud'), user.id, `email.${action}`, entityId, JSON.stringify(result), ctx.clientIp, Date.now()],
    );

    log.info('admin.email_action', {
      action,
      actorId: user.id,
      target: action === 'suppress' ? maskEmail(entityId) : entityId,
    });

    return ok({ action, ...result });
  });
