/**
 * In-app notifications: the bell on the account pages.
 *
 * Both verbs answer with the unread count, because that count is the only thing
 * the header actually renders and a client that derived it from the list would
 * be wrong the moment the list is paginated.
 */

import type { APIRoute } from 'astro';
import { requireUser } from '../../../lib/api';
import { badRequest } from '../../../lib/errors';
import { handle, ok, readJson } from '../../../lib/http';
import { countUnread, listNotifications, markNotificationsRead } from '../../../lib/services/notify';

export const prerender = false;

/** One tap cannot legitimately mark more than a screenful; the cap bounds the SQL. */
const MAX_IDS = 100;

export const GET: APIRoute = async ({ locals, url }) =>
  handle(async () => {
    const { ctx, user } = requireUser(locals);
    const unreadOnly = url.searchParams.get('unread') === '1';

    const rows = await listNotifications(ctx.db, user.id, { unreadOnly });
    const unread = await countUnread(ctx.db, user.id);

    return ok({
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        link: row.link,
        read: row.read_at !== null,
        createdAt: row.created_at,
      })),
      unread,
    });
  });

/** Mark as read: the listed ids, or everything when none are named. */
export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireUser(locals);
    const body = await readJson<{ ids?: unknown }>(request);

    let ids: string[] | undefined;
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids)) throw badRequest('Send the notification ids as a list.');
      if (body.ids.length > MAX_IDS) throw badRequest(`Mark at most ${MAX_IDS} notifications at a time.`);
      ids = body.ids.filter((id): id is string => typeof id === 'string' && id.trim() !== '');
      // An explicit but empty list means "nothing selected". Passing it through
      // would be read as "no ids given" and silently mark every notification.
      if (ids.length === 0) return ok({ marked: 0, unread: await countUnread(ctx.db, user.id) });
    }

    // Scoped to the session's user id inside the service, so a borrowed id from
    // someone else's notification is a no-op rather than a read receipt.
    const marked = await markNotificationsRead(ctx.db, user.id, ids);
    return ok({ marked, unread: await countUnread(ctx.db, user.id) });
  });
