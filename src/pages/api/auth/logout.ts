import type { APIRoute } from 'astro';
import { requireCtx } from '../../../lib/api';
import { endSession } from '../../../lib/auth/session';
import { handle, ok } from '../../../lib/http';

export const prerender = false;

export const POST: APIRoute = async ({ locals, cookies }) =>
  handle(async () => {
    const ctx = requireCtx(locals);
    // The cart cookie deliberately survives sign-out: a shared laptop losing its
    // session should not also lose the basket the next person is buying from.
    await endSession(ctx.db, cookies, ctx.env, ctx.sessionId);
    return ok({ signedOut: true });
  });
