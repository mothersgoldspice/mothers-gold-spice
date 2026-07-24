/**
 * Cookie names and attributes, in one place.
 *
 * Everything is HttpOnly + SameSite=Lax + Secure-outside-dev. Lax rather than
 * Strict because the payment provider redirects the buyer back to us with a
 * top-level GET, and a Strict cookie would be withheld on that navigation —
 * the customer would land on the confirmation page logged out.
 */

import type { AstroCookies } from 'astro';
import { appEnv, type Env } from '../env';

export const SESSION_COOKIE = 'mgs_session';
export const CART_COOKIE = 'mgs_cart';
export const CSRF_COOKIE = 'mgs_csrf';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const CART_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  maxAge?: number;
}

export function cookieOptions(env: Env, maxAgeMs?: number): CookieOptions {
  return {
    httpOnly: true,
    // `astro dev` serves plain http on localhost; a Secure cookie would be dropped.
    secure: appEnv(env) !== 'development',
    sameSite: 'lax',
    path: '/',
    ...(maxAgeMs !== undefined ? { maxAge: Math.floor(maxAgeMs / 1000) } : {}),
  };
}

export function setCookie(cookies: AstroCookies, env: Env, name: string, value: string, maxAgeMs: number): void {
  cookies.set(name, value, cookieOptions(env, maxAgeMs));
}

export function clearCookie(cookies: AstroCookies, env: Env, name: string): void {
  cookies.delete(name, { path: '/', ...(appEnv(env) !== 'development' ? { secure: true } : {}) });
}
