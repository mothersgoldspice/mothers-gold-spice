/**
 * Input schemas. Every value that arrives from a browser passes through one of
 * these before it reaches a service — there is no "trust the caller" path.
 *
 * Messages are written to be shown to the customer as-is, so they say what to do
 * rather than what failed ("Enter a 6-digit PIN code", not "invalid pincode").
 */

import { z } from 'zod';
import { validationFailed } from './errors';
import { isValidPincode } from './shipping-zones';

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Enter your email address.')
  .max(254, 'That email address is too long.')
  .email('Enter a valid email address.');

/**
 * Length over composition rules: a 10-character passphrase beats "Xy1!" and
 * composition requirements mostly produce `Password1!`. The upper bound exists
 * because PBKDF2 hashes whatever it is given and a megabyte password is a cheap
 * way to burn CPU.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters — a short phrase works well.')
  .max(200, 'Passwords can be at most 200 characters.');

/** Indian mobile numbers: 10 digits starting 6-9, with optional +91 / 0 prefix. */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s()-]/g, ''))
  .refine((v) => /^(\+?91|0)?[6-9]\d{9}$/.test(v), 'Enter a 10-digit Indian mobile number.')
  .transform((v) => v.replace(/^(\+?91|0)/, ''));

export const pincodeSchema = z
  .string()
  .trim()
  .refine((v) => isValidPincode(v), 'Enter a valid 6-digit PIN code.');

export const nameSchema = z.string().trim().min(1, 'Enter a name.').max(120, 'That name is too long.');

export const addressSchema = z.object({
  label: z.string().trim().max(40).optional().default('Home'),
  full_name: nameSchema,
  phone: phoneSchema,
  line1: z.string().trim().min(4, 'Enter the house/flat and street.').max(200),
  line2: z.string().trim().max(200).optional().nullable(),
  landmark: z.string().trim().max(120).optional().nullable(),
  city: z.string().trim().min(2, 'Enter the city.').max(80),
  state: z.string().trim().min(2, 'Enter the state.').max(80),
  pincode: pincodeSchema,
  country: z.string().trim().length(2).default('IN'),
});

export type AddressInput = z.infer<typeof addressSchema>;

export const registerSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  phone: phoneSchema.optional(),
  marketing_opt_in: z.coerce.boolean().optional().default(false),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.').max(200),
});

export const cartAddSchema = z.object({
  variant_id: z.string().trim().min(1),
  qty: z.coerce.number().int().min(1).max(99),
});

export const cartUpdateSchema = z.object({
  variant_id: z.string().trim().min(1),
  /** 0 removes the line. */
  qty: z.coerce.number().int().min(0).max(99),
});

export const couponSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'Enter a coupon code.')
    .max(40)
    .regex(/^[A-Z0-9_-]+$/, 'Coupon codes contain letters, numbers, hyphens and underscores.'),
});

export const checkoutSchema = z.object({
  email: emailSchema,
  shipping_address: addressSchema,
  billing_same_as_shipping: z.coerce.boolean().default(true),
  billing_address: addressSchema.optional(),
  payment_method: z.enum(['prepaid', 'cod']).default('prepaid'),
  shipping_method: z.enum(['surface', 'express']).default('surface'),
  customer_note: z.string().trim().max(500).optional().nullable(),
  coupon_code: z.string().trim().max(40).optional().nullable(),
  /** Set when a signed-in customer picked a saved address. */
  address_id: z.string().trim().optional().nullable(),
  /** Client-generated, so a double-submitted checkout produces one order. */
  idempotency_key: z.string().trim().min(8).max(80).optional(),
  create_account: z.coerce.boolean().optional().default(false),
  password: passwordSchema.optional(),
});

export const serviceabilitySchema = z.object({
  pincode: pincodeSchema,
  cod: z.coerce.boolean().optional().default(false),
});

export const passwordResetRequestSchema = z.object({ email: emailSchema });

export const passwordResetSchema = z.object({
  token: z.string().trim().min(16).max(200),
  password: passwordSchema,
});

export const profileUpdateSchema = z.object({
  name: nameSchema.optional(),
  phone: phoneSchema.optional(),
  marketing_opt_in: z.coerce.boolean().optional(),
});

export const passwordChangeSchema = z.object({
  current_password: z.string().min(1, 'Enter your current password.').max(200),
  password: passwordSchema,
});

export const reviewSchema = z.object({
  product_id: z.string().trim().min(1),
  rating: z.coerce.number().int().min(1).max(5),
  title: z.string().trim().max(120).optional().default(''),
  body: z.string().trim().max(2000).optional().default(''),
});

export const newsletterSchema = z.object({
  email: emailSchema,
  source: z.string().trim().max(40).optional().default('footer'),
});

export const stockAlertSchema = z.object({
  variant_id: z.string().trim().min(1),
  email: emailSchema,
});

export const orderStatusSchema = z.object({
  status: z.enum([
    'confirmed',
    'processing',
    'packed',
    'shipped',
    'out_for_delivery',
    'delivered',
    'cancelled',
    'returned',
  ]),
  note: z.string().trim().max(500).optional().nullable(),
});

export const refundSchema = z.object({
  amount_paise: z.coerce.number().int().min(1).optional(),
  reason: z.string().trim().max(300).optional().default('Customer refund'),
});

/**
 * Run a schema and convert a failure into a customer-safe AppError. The first
 * message per field is kept — a form field with three complaints is noise.
 */
export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  const first = Object.values(fieldErrors)[0] ?? 'Please check the details you entered.';
  throw validationFailed(first, { fields: fieldErrors });
}
