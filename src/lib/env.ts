/**
 * Typed access to the Worker environment.
 *
 * Workers hand bindings to each request rather than exposing a module-level
 * `process.env`, so nothing here is a singleton: every helper takes the `Env`
 * the request was given. That is also what makes the whole system testable —
 * a test constructs an `Env` with mock providers and a scratch D1.
 */

// Imported rather than taken from a global `/// <reference>`. Loading
// @cloudflare/workers-types globally also loads HTMLRewriter's `Element`, which
// merges with the DOM's and shadows `append`/`prepend` with signatures that take
// a Response — breaking every client `<script>` that builds a node. See env.d.ts.
import type { D1Database, Fetcher } from '@cloudflare/workers-types';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;

  APP_ENV?: string;
  PUBLIC_SITE_URL?: string;
  STORE_NAME?: string;
  SUPPORT_EMAIL?: string;

  /** Signs cookies, CSRF tokens and guest order links. MUST be set outside dev. */
  SESSION_SECRET?: string;

  EMAIL_PROVIDER?: string;
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;
  RESEND_API_KEY?: string;

  PAYMENT_PROVIDER?: string;
  PADDLE_API_KEY?: string;
  PADDLE_ENVIRONMENT?: string;
  PADDLE_WEBHOOK_SECRET?: string;
  PADDLE_PRICE_ID_DEFAULT?: string;
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;

  SHIPPING_PROVIDER?: string;
  SHIPROCKET_EMAIL?: string;
  SHIPROCKET_PASSWORD?: string;
  SHIPROCKET_WEBHOOK_TOKEN?: string;
  SHIPROCKET_PICKUP_LOCATION?: string;

  /** Guards the mock providers. Must be "false"/absent on a real storefront. */
  ALLOW_MOCK_PROVIDERS?: string;

  /** Shared secret for /api/cron/* maintenance endpoints. */
  CRON_SECRET?: string;

  [key: string]: unknown;
}

export type AppEnvName = 'development' | 'test' | 'staging' | 'production';

export function appEnv(env: Env): AppEnvName {
  const raw = (env.APP_ENV ?? 'development').toLowerCase();
  if (raw === 'production' || raw === 'staging' || raw === 'test') return raw;
  return 'development';
}

/** True where a mock provider silently standing in for a real one would be a bug. */
export function isDeployedEnv(env: Env): boolean {
  const e = appEnv(env);
  return e === 'production' || e === 'staging';
}

/**
 * Mock providers are allowed only when explicitly opted into. The storefront is
 * currently a private pre-launch deployment running entirely on mocks, so
 * ALLOW_MOCK_PROVIDERS=true is set in wrangler.jsonc; flipping it to false is
 * the switch that makes a mock provider refuse to initialise.
 */
export function mocksAllowed(env: Env): boolean {
  if (!isDeployedEnv(env)) return true;
  return String(env.ALLOW_MOCK_PROVIDERS ?? 'false').toLowerCase() === 'true';
}

export function requireEnv(env: Env, key: keyof Env & string): string {
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function optionalEnv(env: Env, key: keyof Env & string, fallback = ''): string {
  const value = env[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Secret used for HMACs. In development a fixed development-only value keeps
 * `astro dev` working with no setup; anywhere deployed an unset secret is fatal
 * because it would make CSRF tokens and guest order links forgeable.
 */
export function sessionSecret(env: Env): string {
  const secret = env.SESSION_SECRET;
  if (typeof secret === 'string' && secret.length >= 16) return secret;
  if (isDeployedEnv(env)) {
    throw new Error('SESSION_SECRET is unset (or shorter than 16 chars) in a deployed environment.');
  }
  return 'dev-only-insecure-session-secret-do-not-ship';
}

export function siteUrl(env: Env): string {
  return optionalEnv(env, 'PUBLIC_SITE_URL', 'http://localhost:4321').replace(/\/$/, '');
}

export function storeName(env: Env): string {
  return optionalEnv(env, 'STORE_NAME', "Mother's Gold Spice");
}

export function supportEmail(env: Env): string {
  return optionalEnv(env, 'SUPPORT_EMAIL', 'mothersgoldspice@gmail.com');
}
