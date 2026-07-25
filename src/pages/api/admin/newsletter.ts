/**
 * The mailing list, from the kitchen's side.
 *
 * Two jobs, and the second one is why this route exists at all: somebody has to
 * be able to take an address off the list from the console, because a person who
 * asks by replying to the email — or by telephone — has still asked, and under
 * the DPDP Act "we only honour the link" is not an answer.
 *
 * The CSV export is a real download rather than a JSON blob to copy out of a
 * browser tab, because the list is only useful inside whatever actually sends
 * the mail. It also writes an audit row: exporting every subscriber's address is
 * the single largest movement of personal data this console can perform, and a
 * record of who took a copy and when is the least it should leave behind.
 */

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { readPaging, requireAdmin } from '../../../lib/api';
import { notFound } from '../../../lib/errors';
import { handle, ok, readJson } from '../../../lib/http';
import { newId } from '../../../lib/ids';
import { log, maskEmail } from '../../../lib/log';
import { emailSchema, parseOrThrow } from '../../../lib/validate';

export const prerender = false;

/**
 * A ceiling on the export rather than the whole table unbounded. At the size
 * this shop will plausibly reach it never bites; if it ever does, a truncated
 * file that downloads beats a request that runs out of memory and returns
 * nothing. The page says so when the cap is hit.
 */
const CSV_MAX_ROWS = 5000;

const filterSchema = z.object({
  status: z.enum(['subscribed', 'unsubscribed']).nullable().optional(),
  search: z.string().trim().max(120, 'That search is too long.').nullable().optional(),
  format: z.enum(['json', 'csv'], { errorMap: () => ({ message: 'Ask for json or csv.' }) }).nullable().optional(),
});

interface SubscriberRow {
  id: string;
  email: string;
  status: string;
  source: string | null;
  created_at: number;
  unsubscribed_at: number | null;
}

/**
 * One CSV field, escaped twice over.
 *
 * RFC 4180 first: a value containing a comma, a quote or a newline is wrapped in
 * quotes and its own quotes are doubled. Then the spreadsheet problem — Excel
 * and Sheets evaluate a cell beginning `=`, `+`, `-` or `@` as a formula, and
 * `=cmd|...` is both a legal mailbox local-part and a live exploit the moment
 * somebody double-clicks the file. A leading apostrophe defuses it.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * `2026-07-25 14:30` in IST.
 *
 * `sv-SE` is not a typo and not a joke about Sweden: it is the one widely
 * supported locale whose short format is already ISO-shaped, which is what a
 * spreadsheet parses as a date without being argued with. Epoch milliseconds in
 * a column somebody has to read is not an answer.
 */
function csvStamp(ms: number | null): string {
  if (ms === null) return '';
  return new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 16);
}

export const GET: APIRoute = async ({ locals, url }) =>
  handle(async () => {
    const { ctx, user } = requireAdmin(locals);

    const filters = parseOrThrow(filterSchema, {
      status: url.searchParams.get('status') || null,
      search: url.searchParams.get('search') || null,
      format: url.searchParams.get('format') || null,
    });

    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filters.status) {
      where.push('status = ?');
      params.push(filters.status);
    }
    if (filters.search) {
      where.push('LOWER(email) LIKE ?');
      params.push(`%${filters.search.toLowerCase()}%`);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    if (filters.format === 'csv') {
      // The export deliberately ignores paging. A file containing page 3 of the
      // mailing list is not an export of anything.
      const rows = await ctx.db.all<SubscriberRow>(
        `SELECT id, email, status, source, created_at, unsubscribed_at
           FROM newsletter_subscribers ${clause}
          ORDER BY created_at DESC
          LIMIT ?`,
        [...params, CSV_MAX_ROWS],
      );

      // CRLF and a trailing newline, per RFC 4180 — Excel is the fussiest reader
      // this file will meet and it is the one that cares.
      const body = [
        ['email', 'status', 'source', 'signed_up_ist', 'unsubscribed_ist'].join(','),
        ...rows.map((r) =>
          [
            csvCell(r.email),
            csvCell(r.status),
            csvCell(r.source ?? ''),
            csvCell(csvStamp(r.created_at)),
            csvCell(csvStamp(r.unsubscribed_at)),
          ].join(','),
        ),
      ].join('\r\n');

      const filename = `newsletter-${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' })}.csv`;

      await ctx.db.run(
        `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, data_json, ip, created_at)
         VALUES (?, 'admin', ?, 'newsletter.export', 'newsletter', 'csv', ?, ?, ?)`,
        [
          newId('aud'),
          user.id,
          JSON.stringify({ rows: rows.length, truncated: rows.length === CSV_MAX_ROWS, filters }),
          ctx.clientIp,
          Date.now(),
        ],
      );
      log.info('admin.newsletter_export', { actorId: user.id, rows: rows.length });

      return new Response(`${body}\r\n`, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          // Belt and braces over the middleware: a mailing list must not sit in
          // a shared cache or a browser's disk cache.
          'Cache-Control': 'no-store, must-revalidate',
        },
      });
    }

    const { limit, offset } = readPaging(url, 50, 200);

    const total = (await ctx.db.scalar<number>(`SELECT COUNT(*) FROM newsletter_subscribers ${clause}`, params)) ?? 0;

    // Counts are of the WHOLE list, not the filtered view: they are the headline
    // "how many people can we actually write to", and a count that changes when
    // you type in the search box answers a different question.
    const counts = await ctx.db.all<{ status: string; count: number }>(
      'SELECT status, COUNT(*) AS count FROM newsletter_subscribers GROUP BY status',
    );
    const countFor = (status: string): number => counts.find((c) => c.status === status)?.count ?? 0;

    const rows = await ctx.db.all<SubscriberRow>(
      `SELECT id, email, status, source, created_at, unsubscribed_at
         FROM newsletter_subscribers ${clause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return ok({
      items: rows.map((r) => ({
        id: r.id,
        email: r.email,
        status: r.status,
        source: r.source,
        createdAt: r.created_at,
        unsubscribedAt: r.unsubscribed_at,
      })),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      subscribed: countFor('subscribed'),
      unsubscribed: countFor('unsubscribed'),
    });
  });

/**
 * Strict, and only an address. There is no "resubscribe" here on purpose: adding
 * somebody back is consent, and consent is theirs to give through the form, not
 * ours to restore from the console.
 */
const unsubscribeSchema = z
  .object({
    email: emailSchema,
  })
  .strict();

export const PATCH: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireAdmin(locals);
    const { email } = parseOrThrow(unsubscribeSchema, await readJson<Record<string, unknown>>(request));

    const row = await ctx.db.first<{ id: string; status: string; unsubscribed_at: number | null }>(
      'SELECT id, status, unsubscribed_at FROM newsletter_subscribers WHERE email = ?',
      [email],
    );
    if (!row) throw notFound('That address is not on the newsletter list.');

    const now = Date.now();
    // Guarded on the current status so a second press does not overwrite the
    // date on which they actually left with today's.
    const changed = await ctx.db.run(
      `UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribed_at = ?
        WHERE id = ? AND status = 'subscribed'`,
      [now, row.id],
    );

    await ctx.db.run(
      `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, data_json, ip, created_at)
       VALUES (?, 'admin', ?, 'newsletter.unsubscribe', 'newsletter_subscriber', ?, ?, ?, ?)`,
      [
        newId('aud'),
        user.id,
        row.id,
        JSON.stringify({ email, alreadyUnsubscribed: changed === 0 }),
        ctx.clientIp,
        now,
      ],
    );

    log.info('admin.newsletter_unsubscribe', {
      actorId: user.id,
      email: maskEmail(email),
      alreadyUnsubscribed: changed === 0,
    });

    return ok({
      email,
      status: 'unsubscribed',
      unsubscribedAt: changed === 0 ? row.unsubscribed_at : now,
      alreadyUnsubscribed: changed === 0,
    });
  });
