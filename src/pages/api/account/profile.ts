/**
 * The signed-in customer's own profile.
 *
 * The email address is deliberately read-only here. It is the key a guest order
 * is later claimed by and the address every receipt has already gone to, so
 * changing it needs a verified flow of its own rather than a field on a form.
 */

import type { APIRoute } from 'astro';
import { requireUser } from '../../../lib/api';
import type { AppContext } from '../../../lib/context';
import { internal } from '../../../lib/errors';
import { handle, ok, readJson } from '../../../lib/http';
import { findUserById, updateProfile } from '../../../lib/services/accounts';
import { parseOrThrow, profileUpdateSchema } from '../../../lib/validate';

export const prerender = false;

interface ProfileResponse {
  name: string;
  email: string;
  phone: string | null;
  marketingOptIn: boolean;
  emailVerified: boolean;
  createdAt: number;
}

/**
 * Read the profile back from the database rather than from the session.
 *
 * The session snapshot is minutes-to-hours old, so after a PATCH it would still
 * report the previous name — and the phone and marketing flag are not on it at
 * all.
 */
async function readProfile(ctx: AppContext, userId: string): Promise<ProfileResponse> {
  const user = await findUserById(ctx.db, userId);
  if (!user) throw internal('A live session resolved to a user row that no longer exists.');

  return {
    name: user.name,
    email: user.email,
    phone: user.phone,
    marketingOptIn: user.marketing_opt_in === 1,
    emailVerified: user.email_verified_at !== null,
    createdAt: user.created_at,
  };
}

export const GET: APIRoute = async ({ locals }) =>
  handle(async () => {
    const { ctx, user } = requireUser(locals);
    return ok(await readProfile(ctx, user.id));
  });

export const PATCH: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireUser(locals);
    const input = parseOrThrow(profileUpdateSchema, await readJson(request));

    // The id comes from the session, never from the body — otherwise this route
    // would let anyone edit any account by guessing an id.
    await updateProfile(ctx.db, user.id, {
      name: input.name,
      phone: input.phone,
      marketingOptIn: input.marketing_opt_in,
    });

    return ok(await readProfile(ctx, user.id));
  });
