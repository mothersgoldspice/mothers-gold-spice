/**
 * Coupons, from the shop's side.
 *
 * The whole difficulty here is units. One `value` column means three different
 * things depending on `type` — basis points, paise, or nothing at all — and
 * every one of them is a number that looks perfectly reasonable in the wrong
 * unit. A `value` of 10 on a percent coupon is 0.1%, which takes fifty paise off
 * a ₹499 basket and reads to the customer as a code that did not work.
 *
 * So this route never accepts a bare `value`. It takes `percent_off` in HUMAN
 * percent and `amount_off_paise` in paise — fields whose names carry their unit —
 * and does the one multiplication itself. An API that accepted raw basis points
 * would happily store 10 from a hand-rolled request and nothing downstream would
 * ever notice; a schema that only accepts 0.01–100 cannot express that mistake.
 *
 * `used_count` appears in no schema and in no UPDATE here. It is a running total
 * that `coupon_redemptions` is the ledger for, and letting it be typed in is how
 * an exhausted single-use code springs back to life — the coupon equivalent of
 * resetting stock. `code` is absent from the patch for a different reason: it has
 * been printed on flyers and pasted into WhatsApp, so it is permanent. Disable
 * the old code and issue a new one.
 */

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { requireAdmin } from '../../../lib/api';
import type { AppContext } from '../../../lib/context';
import type { CouponRow, CouponType } from '../../../lib/db/types';
import { badRequest, conflict, notFound } from '../../../lib/errors';
import { created, handle, ok, readJson } from '../../../lib/http';
import { newId } from '../../../lib/ids';
import { log } from '../../../lib/log';
import { parseOrThrow } from '../../../lib/validate';

export const prerender = false;

/**
 * India is UTC+05:30 all year — there has been no daylight saving since 1945 —
 * so a fixed offset is exact for every date rather than an approximation that
 * would drift twice a year the way a European one does.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * The sanity rail on money, not a business limit: nothing here is legitimately
 * near ₹1,00,000, so a number above it is almost certainly rupees typed into a
 * paise field.
 */
const paise = z
  .number({ invalid_type_error: 'Enter an amount in paise, as a plain number.' })
  .int('Amounts are whole paise — no decimals.')
  .min(0, 'That amount cannot be negative.')
  .max(10_000_000, 'That amount is far higher than we allow. Amounts are in paise, not rupees.');

/**
 * `''` clears the date; anything else must be a calendar day as the date input
 * writes it. A `refine` rather than a union of two string schemas, because a
 * zod union reports a failure as the unhelpful "Invalid input" and these
 * messages are shown to the operator word for word.
 */
const dayString = z
  .string()
  .refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Enter the date as YYYY-MM-DD, or leave it blank.');

const codeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(3, 'A coupon code needs at least three characters.')
  .max(40, 'Keep the code under 40 characters.')
  .regex(/^[A-Z0-9_-]+$/, 'Coupon codes contain letters, numbers, hyphens and underscores.');

/**
 * Everything that is not the code, shared by create and update so the two cannot
 * drift apart on what a valid coupon is.
 *
 * `percent_off` is HUMAN percent — 10 means 10%. It is deliberately not named
 * after the column it feeds: a field called `value` invites a caller to send the
 * basis points it is stored as, and that is the mistake this whole file is
 * arranged to prevent.
 */
const couponFields = {
  description: z.string().trim().max(200, 'Keep the description under 200 characters.'),
  type: z.enum(['percent', 'fixed', 'free_shipping'], {
    errorMap: () => ({ message: 'Choose a discount type: percentage, fixed amount, or free delivery.' }),
  }),
  percent_off: z
    .number({ invalid_type_error: 'Enter the percentage as a plain number — 10 means 10%.' })
    .min(0.01, 'A discount below 0.01% is not a discount.')
    .max(100, 'A discount above 100% would pay people to shop.'),
  amount_off_paise: paise.min(100, 'A fixed discount of under ₹1 is not worth a code.'),
  min_subtotal_paise: paise,
  /** `null` is no cap: `couponDiscountPaise` applies `Math.min` only when it is set. */
  max_discount_paise: z.union([paise.min(100, 'A cap under ₹1 makes the coupon worthless.'), z.null()]),
  starts_on: dayString,
  ends_on: dayString,
  /** `null` is unlimited, matching the nullable column `validateCoupon` tests for. */
  usage_limit: z.union([
    z
      .number()
      .int('Enter a whole number of redemptions.')
      .min(1, 'A limit of zero would make the code dead on arrival — leave it blank for no limit.')
      .max(1_000_000),
    z.null(),
  ]),
  per_user_limit: z
    .number()
    .int('Enter a whole number of redemptions.')
    .min(0, 'That cannot be negative — 0 means no per-customer limit.')
    .max(100, 'A hundred per customer is effectively unlimited; use 0 for that.'),
  first_order_only: z.boolean(),
  status: z.enum(['active', 'disabled'], {
    errorMap: () => ({ message: 'A coupon is either active or disabled.' }),
  }),
};

/**
 * Defaults are the cautious reading of a half-filled form: one redemption per
 * customer, no spend floor, no cap, live now. Strict, because an unrecognised key
 * is a mistake worth rejecting rather than a field worth ignoring — `usage_limt`
 * quietly doing nothing is how a code gets given away for a month.
 */
const createSchema = z
  .object({
    code: codeSchema,
    description: couponFields.description.default(''),
    type: couponFields.type,
    percent_off: couponFields.percent_off.optional(),
    amount_off_paise: couponFields.amount_off_paise.optional(),
    min_subtotal_paise: couponFields.min_subtotal_paise.default(0),
    max_discount_paise: couponFields.max_discount_paise.default(null),
    starts_on: couponFields.starts_on.default(''),
    ends_on: couponFields.ends_on.default(''),
    usage_limit: couponFields.usage_limit.default(null),
    per_user_limit: couponFields.per_user_limit.default(1),
    first_order_only: couponFields.first_order_only.default(false),
    status: couponFields.status.default('active'),
  })
  .strict();

/**
 * Partial by design — switching a coupon off sends two keys, not fourteen — so
 * every rule below runs against the MERGED result rather than the handful of
 * fields that happened to arrive.
 */
const patchSchema = z
  .object({
    id: z.string().trim().min(1, 'Which coupon?'),
    description: couponFields.description.optional(),
    type: couponFields.type.optional(),
    percent_off: couponFields.percent_off.optional(),
    amount_off_paise: couponFields.amount_off_paise.optional(),
    min_subtotal_paise: couponFields.min_subtotal_paise.optional(),
    max_discount_paise: couponFields.max_discount_paise.optional(),
    starts_on: couponFields.starts_on.optional(),
    ends_on: couponFields.ends_on.optional(),
    usage_limit: couponFields.usage_limit.optional(),
    per_user_limit: couponFields.per_user_limit.optional(),
    first_order_only: couponFields.first_order_only.optional(),
    status: couponFields.status.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 1, 'There is nothing to save.');

/**
 * 10 → 1000.
 *
 * The `value` column on a percent coupon is basis points, because
 * `couponDiscountPaise` divides by 10,000. Storing a plain 10 there means 0.1%.
 * This is the only place in the system that performs the conversion, and it is
 * on the server precisely so that no caller can skip it.
 */
const percentToBps = (percent: number): number => Math.round(percent * 100);

/** Midnight at the START of an IST calendar day, as epoch ms. */
function istDayStart(day: string): number | null {
  return day === '' ? null : istInstant(day, 0, 0, 0, 0);
}

/**
 * The LAST millisecond of an IST calendar day, as epoch ms.
 *
 * A coupon advertised "valid until the 30th" whose `ends_at` is midnight at the
 * START of the 30th is dead the moment the 29th ends — `validateCoupon` rejects
 * anything with `now > ends_at`. An end date therefore means the end of that day
 * in the shop's own timezone, which is the only reading a customer or an
 * operator would ever put on it.
 */
function istDayEnd(day: string): number | null {
  return day === '' ? null : istInstant(day, 23, 59, 59, 999);
}

/**
 * A wall-clock time on an IST calendar day, converted to epoch ms.
 *
 * `Date.UTC` is used rather than the local-time constructor on purpose: a Worker
 * runs in UTC and a laptop does not, and a coupon window that depended on where
 * the process happened to be running would expire five and a half hours early in
 * one of them.
 */
function istInstant(day: string, hours: number, minutes: number, seconds: number, ms: number): number {
  const [year, month, date] = day.split('-').map(Number);
  const asUtc = Date.UTC(year, month - 1, date, hours, minutes, seconds, ms);

  // `Date.UTC` rolls 31 February over into March rather than complaining, so the
  // parts are read back to confirm the operator typed a day that exists.
  const probe = new Date(asUtc);
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== date) {
    throw badRequest(`${day} is not a real date.`);
  }

  return asUtc - IST_OFFSET_MS;
}

interface CouponUsageRow extends CouponRow {
  redemption_count: number;
  discount_given_paise: number;
  last_redeemed_at: number | null;
}

/**
 * Usage totals in one query, not one plus N.
 *
 * At five coupons a count per row is invisible; it is also exactly the shape
 * that stops loading once a code has been in a newsletter, so the aggregate is a
 * LEFT JOIN and a GROUP BY. LEFT, not inner: a coupon nobody has used yet is the
 * most interesting row on the page.
 */
const USAGE_COLUMNS = `c.*,
            COUNT(r.id) AS redemption_count,
            COALESCE(SUM(r.amount_paise), 0) AS discount_given_paise,
            MAX(r.created_at) AS last_redeemed_at`;

/**
 * The wire shape spells the units out.
 *
 * `value` is echoed as stored, but `percentOff` and `amountOffPaise` are what a
 * consumer should read: exactly one of them is non-null, and neither can be
 * misread the way a bare `value` can.
 */
function toResponse(row: CouponUsageRow): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    type: row.type,
    value: row.value,
    percentOff: row.type === 'percent' ? row.value / 100 : null,
    amountOffPaise: row.type === 'fixed' ? row.value : null,
    minSubtotalPaise: row.min_subtotal_paise,
    maxDiscountPaise: row.max_discount_paise,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    usageLimit: row.usage_limit,
    perUserLimit: row.per_user_limit,
    usedCount: row.used_count,
    firstOrderOnly: row.first_order_only === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    redemptionCount: row.redemption_count,
    discountGivenPaise: row.discount_given_paise,
    lastRedeemedAt: row.last_redeemed_at,
  };
}

export const GET: APIRoute = async ({ locals }) =>
  handle(async () => {
    const { ctx } = requireAdmin(locals);

    const rows = await ctx.db.all<CouponUsageRow>(
      `SELECT ${USAGE_COLUMNS}
         FROM coupons c
         LEFT JOIN coupon_redemptions r ON r.coupon_id = c.id
        GROUP BY c.id
        ORDER BY CASE c.status WHEN 'active' THEN 0 ELSE 1 END, c.created_at DESC`,
    );

    return ok({
      coupons: rows.map(toResponse),
      totalDiscountGivenPaise: rows.reduce((sum, row) => sum + row.discount_given_paise, 0),
    });
  });

export const POST: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireAdmin(locals);
    const input = parseOrThrow(createSchema, await readJson<Record<string, unknown>>(request));

    const value = valueForType(input.type, input, true);
    const maxDiscount = capForType(input.type, input.max_discount_paise, null);
    const startsAt = istDayStart(input.starts_on);
    const endsAt = istDayEnd(input.ends_on);
    assertWindow(startsAt, endsAt);

    // Checked before the insert so a collision reads as "that code is taken"
    // rather than as a constraint failure. The catch below covers the race
    // between this read and the write.
    const clash = await ctx.db.first<{ id: string }>('SELECT id FROM coupons WHERE code = ?', [input.code]);
    if (clash) throw conflict(`${input.code} already exists. Disable that one, or pick another code.`);

    const id = newId('cpn');
    const now = Date.now();

    try {
      await ctx.db.run(
        `INSERT INTO coupons (id, code, description, type, value, min_subtotal_paise, max_discount_paise,
                              starts_at, ends_at, usage_limit, per_user_limit, used_count, first_order_only,
                              status, provider_discount_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)`,
        [
          id,
          input.code,
          input.description,
          input.type,
          value,
          input.min_subtotal_paise,
          maxDiscount,
          startsAt,
          endsAt,
          input.usage_limit,
          input.per_user_limit,
          input.first_order_only ? 1 : 0,
          input.status,
          now,
          now,
        ],
      );
    } catch (err) {
      // Two operators creating the same code in the same second.
      if (err instanceof Error && /UNIQUE/i.test(err.message)) {
        throw conflict(`${input.code} already exists. Disable that one, or pick another code.`);
      }
      throw err;
    }

    await writeAudit(ctx, user.id, 'coupon.create', id, {
      code: input.code,
      type: input.type,
      value,
      minSubtotalPaise: input.min_subtotal_paise,
      maxDiscountPaise: maxDiscount,
      startsAt,
      endsAt,
      usageLimit: input.usage_limit,
      perUserLimit: input.per_user_limit,
      firstOrderOnly: input.first_order_only,
      status: input.status,
    });

    log.info('admin.coupon_created', { couponId: id, code: input.code, type: input.type, actorId: user.id });

    return created({ coupon: toResponse(await readBack(ctx, id)) });
  });

export const PATCH: APIRoute = async ({ locals, request }) =>
  handle(async () => {
    const { ctx, user } = requireAdmin(locals);
    const input = parseOrThrow(patchSchema, await readJson<Record<string, unknown>>(request));

    const existing = await ctx.db.first<CouponRow>('SELECT * FROM coupons WHERE id = ?', [input.id]);
    if (!existing) throw notFound('We could not find that coupon.');

    const type = input.type ?? existing.type;
    const typeChanged = type !== existing.type;

    const value = valueForType(type, input, typeChanged, existing);
    const startsAt = input.starts_on !== undefined ? istDayStart(input.starts_on) : existing.starts_at;
    const endsAt = input.ends_on !== undefined ? istDayEnd(input.ends_on) : existing.ends_at;
    assertWindow(startsAt, endsAt);

    const next = {
      description: input.description ?? existing.description,
      type,
      value,
      min_subtotal_paise: input.min_subtotal_paise ?? existing.min_subtotal_paise,
      max_discount_paise: capForType(type, input.max_discount_paise, existing.max_discount_paise),
      starts_at: startsAt,
      ends_at: endsAt,
      usage_limit: input.usage_limit !== undefined ? input.usage_limit : existing.usage_limit,
      per_user_limit: input.per_user_limit ?? existing.per_user_limit,
      first_order_only:
        input.first_order_only === undefined ? existing.first_order_only : input.first_order_only ? 1 : 0,
      status: input.status ?? existing.status,
    };

    // A code already claimed more times than its new ceiling would be dead the
    // moment it saved, which is a bewildering way to discover a typo.
    if (next.usage_limit !== null && existing.used_count > next.usage_limit) {
      throw badRequest(
        `${existing.code} has already been used ${existing.used_count} times, so a limit of ${next.usage_limit} would retire it immediately. Disable it instead if that is what you meant.`,
      );
    }

    const changes: Record<string, [unknown, unknown]> = {};
    for (const [key, after] of Object.entries(next)) {
      const before = existing[key as keyof typeof next];
      if (before !== after) changes[key] = [before, after];
    }

    // A save that changes nothing — a double-clicked disable, usually — should
    // not bump `updated_at` or leave an audit row that records no action.
    if (Object.keys(changes).length === 0) {
      return ok({ coupon: toResponse(await readBack(ctx, existing.id)), changed: [] });
    }

    // `used_count` is absent from this SET clause on purpose, and the schema
    // above refuses a field for it: the count is the tally of
    // `coupon_redemptions`, and editing it would resurrect a spent code.
    await ctx.db.run(
      `UPDATE coupons
          SET description = ?, type = ?, value = ?, min_subtotal_paise = ?, max_discount_paise = ?,
              starts_at = ?, ends_at = ?, usage_limit = ?, per_user_limit = ?, first_order_only = ?,
              status = ?, updated_at = ?
        WHERE id = ?`,
      [
        next.description,
        next.type,
        next.value,
        next.min_subtotal_paise,
        next.max_discount_paise,
        next.starts_at,
        next.ends_at,
        next.usage_limit,
        next.per_user_limit,
        next.first_order_only,
        next.status,
        Date.now(),
        existing.id,
      ],
    );

    await writeAudit(ctx, user.id, 'coupon.update', existing.id, { code: existing.code, changes });

    log.info('admin.coupon_updated', {
      couponId: existing.id,
      code: existing.code,
      changed: Object.keys(changes),
      actorId: user.id,
    });

    return ok({ coupon: toResponse(await readBack(ctx, existing.id)), changed: Object.keys(changes) });
  });

/**
 * Resolve the single `value` column from whichever human-unit field belongs to
 * the type — and refuse the one that does not.
 *
 * Silently ignoring a rupee amount sent with a percentage coupon is the failure
 * this exists to prevent: the operator watches the number they typed get
 * accepted while the coupon keeps the percentage it always had.
 *
 * `mustSupply` is true on create and whenever the type CHANGES, because the
 * stored number is then in the wrong unit: inheriting it turns 10% into ₹10, or
 * ₹10 into 0.1%.
 */
function valueForType(
  type: CouponType,
  input: { percent_off?: number; amount_off_paise?: number },
  mustSupply: boolean,
  existing?: CouponRow,
): number {
  if (type === 'free_shipping') {
    if (input.percent_off !== undefined || input.amount_off_paise !== undefined) {
      throw badRequest('A free-delivery coupon has no amount of its own — it waives whatever delivery costs.');
    }
    // Zeroed rather than left alone: a stale 1000 sitting in the column would be
    // inherited in the wrong unit by a later switch back to a fixed amount.
    return 0;
  }

  if (type === 'percent') {
    if (input.amount_off_paise !== undefined) {
      throw badRequest('That is a percentage coupon. Set the percentage, not a rupee amount.');
    }
    if (input.percent_off !== undefined) return percentToBps(input.percent_off);
    if (mustSupply) {
      throw badRequest('Switching to a percentage coupon needs the percentage — the stored amount is in rupees.');
    }
    return existing?.value ?? 0;
  }

  if (input.percent_off !== undefined) {
    throw badRequest('That is a fixed-amount coupon. Set the rupee amount, not a percentage.');
  }
  if (input.amount_off_paise !== undefined) return input.amount_off_paise;
  if (mustSupply) {
    throw badRequest('Switching to a fixed-amount coupon needs the amount — the stored value is a percentage.');
  }
  return existing?.value ?? 0;
}

/**
 * A cap belongs to percentage coupons alone: `couponDiscountPaise` consults it
 * only on that branch, so a cap on a fixed amount is a number that does nothing.
 * Sending one is a mistake worth reporting; one merely left behind by a type
 * change is cleared, so nothing stale survives in the column.
 */
function capForType(type: CouponType, supplied: number | null | undefined, inherited: number | null): number | null {
  if (type !== 'percent') {
    if (supplied !== undefined && supplied !== null) {
      throw badRequest('A maximum discount only means something on a percentage coupon.');
    }
    return null;
  }
  return supplied !== undefined ? supplied : inherited;
}

function assertWindow(startsAt: number | null, endsAt: number | null): void {
  if (startsAt !== null && endsAt !== null && endsAt < startsAt) {
    throw badRequest('The end date falls before the start date.');
  }
}

/** Read the row back with its usage totals, so the caller sees what was stored. */
async function readBack(ctx: AppContext, id: string): Promise<CouponUsageRow> {
  const row = await ctx.db.first<CouponUsageRow>(
    `SELECT ${USAGE_COLUMNS}
       FROM coupons c
       LEFT JOIN coupon_redemptions r ON r.coupon_id = c.id
      WHERE c.id = ?
      GROUP BY c.id`,
    [id],
  );
  if (!row) throw notFound('We could not find that coupon.');
  return row;
}

async function writeAudit(
  ctx: AppContext,
  actorId: string,
  action: string,
  couponId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await ctx.db.run(
    `INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, data_json, ip, created_at)
     VALUES (?, 'admin', ?, ?, 'coupon', ?, ?, ?, ?)`,
    [newId('aud'), actorId, action, couponId, JSON.stringify(data), ctx.clientIp, Date.now()],
  );
}
