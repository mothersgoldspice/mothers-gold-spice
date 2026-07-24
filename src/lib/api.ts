/**
 * Guards and helpers shared by API routes and on-demand pages.
 *
 * Every route starts by naming what it requires — `requireCtx`, `requireUser`,
 * `requireAdmin` — so authorisation is a visible first line rather than
 * something you have to reconstruct by reading the handler. A route with no
 * guard is anonymous ON PURPOSE, and that is reviewable.
 */

import type { APIContext } from 'astro';
import type { AppContext, SessionUser } from './context';
import { forbidden, internal, unauthorized } from './errors';

/**
 * Every on-demand route MUST set this. Astro's default in `static` output is to
 * prerender, which for an API route means it is baked at build time with no
 * database — reachable, and permanently returning whatever the build produced.
 */
export const prerender = false;

/** The per-request container. Absent only if a route is wrongly prerendered. */
export function requireCtx(locals: App.Locals): AppContext {
  const ctx = locals.ctx;
  if (!ctx) {
    throw internal(
      'Request context is missing. The route is being prerendered — add `export const prerender = false`.',
    );
  }
  return ctx;
}

export function requireUser(locals: App.Locals): { ctx: AppContext; user: SessionUser } {
  const ctx = requireCtx(locals);
  if (!ctx.user) throw unauthorized();
  return { ctx, user: ctx.user };
}

export function requireAdmin(locals: App.Locals): { ctx: AppContext; user: SessionUser } {
  const { ctx, user } = requireUser(locals);
  if (user.role !== 'admin' && user.role !== 'staff') throw forbidden('That area is staff only.');
  return { ctx, user };
}

/** Rate-limit key scoped to the caller: user id when known, else client IP. */
export function rateKey(ctx: AppContext, bucket: string): string {
  return `${bucket}:${ctx.user?.id ?? ctx.clientIp}`;
}

/** Read pagination from the query string with sane, bounded defaults. */
export function readPaging(url: URL, defaultLimit = 25, maxLimit = 100): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '', 10) || defaultLimit, 1), maxLimit);
  const page = Math.max(Number.parseInt(url.searchParams.get('page') ?? '', 10) || 1, 1);
  return { limit, offset: (page - 1) * limit };
}

/** Merge a JSON body and query string into one record for schema parsing. */
export async function readInput(context: APIContext): Promise<Record<string, unknown>> {
  const fromQuery = Object.fromEntries(new URL(context.request.url).searchParams.entries());
  if (context.request.method === 'GET' || context.request.method === 'HEAD') return fromQuery;

  const contentType = context.request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const text = await context.request.text();
    if (!text) return fromQuery;
    return { ...fromQuery, ...(JSON.parse(text) as Record<string, unknown>) };
  }
  if (contentType.includes('form')) {
    const form = await context.request.formData();
    const out: Record<string, unknown> = { ...fromQuery };
    for (const [key, value] of form.entries()) if (typeof value === 'string') out[key] = value;
    return out;
  }
  return fromQuery;
}
