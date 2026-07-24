/**
 * The saved address book.
 *
 * Every verb answers with the WHOLE list, the way the cart routes answer with
 * the whole cart. Saving an address can move the default onto it and deleting
 * one can promote a different address into that slot, so a client that patched
 * its local copy from a narrower response would quietly go out of step with the
 * server about which address checkout will pick.
 */

import type { APIRoute } from 'astro';
import { requireUser } from '../../../lib/api';
import type { AppContext } from '../../../lib/context';
import type { AddressRow } from '../../../lib/db/types';
import { badRequest } from '../../../lib/errors';
import { created, handle, ok, readJson } from '../../../lib/http';
import {
  deleteAddress,
  getAddress,
  listAddresses,
  saveAddress,
  setDefaultAddress,
} from '../../../lib/services/accounts';
import { addressSchema, parseOrThrow } from '../../../lib/validate';

export const prerender = false;

function toView(row: AddressRow) {
  return {
    id: row.id,
    label: row.label,
    fullName: row.full_name,
    phone: row.phone,
    line1: row.line1,
    line2: row.line2,
    landmark: row.landmark,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    country: row.country,
    isDefault: row.is_default_shipping === 1,
    updatedAt: row.updated_at,
  };
}

async function listResponse(ctx: AppContext, userId: string, addressId?: string) {
  const rows = await listAddresses(ctx.db, userId);
  return { addresses: rows.map(toView), ...(addressId ? { addressId } : {}) };
}

/** A checkbox arrives as `true` from fetch and as `"true"` from a form post. */
function readFlag(value: unknown): boolean {
  return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

function readAddressId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest('Which address did you mean?');
  return value.trim();
}

export const GET: APIRoute = async ({ locals }) =>
  handle(async () => {
    const { ctx, user } = requireUser(locals);
    return ok(await listResponse(ctx, user.id));
  });

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireUser(locals);
    const body = await readJson<Record<string, unknown>>(request);
    const input = parseOrThrow(addressSchema, body);

    const addressId = await saveAddress(ctx.db, user.id, input, { makeDefault: readFlag(body.make_default) });
    return created(await listResponse(ctx, user.id, addressId));
  });

export const PATCH: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireUser(locals);
    const body = await readJson<Record<string, unknown>>(request);
    const addressId = readAddressId(body.address_id);

    // The address list has a "Make this my default" control that carries an id
    // and nothing else. Treat a body with no address fields as exactly that,
    // rather than making a phone re-upload an address it is not changing.
    if (body.line1 === undefined) {
      if (!readFlag(body.make_default)) throw badRequest('There is nothing to change in that address.');
      // Ownership is proved before the write; `setDefaultAddress` scopes by user
      // id but says nothing when the id belongs to somebody else.
      await getAddress(ctx.db, user.id, addressId);
      await setDefaultAddress(ctx.db, user.id, addressId);
      return ok(await listResponse(ctx, user.id, addressId));
    }

    const input = parseOrThrow(addressSchema, body);
    await saveAddress(ctx.db, user.id, input, { addressId, makeDefault: readFlag(body.make_default) });
    return ok(await listResponse(ctx, user.id, addressId));
  });

export const DELETE: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireUser(locals);
    const body = await readJson<Record<string, unknown>>(request);

    await deleteAddress(ctx.db, user.id, readAddressId(body.address_id));
    return ok(await listResponse(ctx, user.id));
  });
